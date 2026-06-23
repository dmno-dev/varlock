import { createHash } from 'node:crypto';
import type { EnvGraph, SerializedEnvGraph } from '../../env-graph/lib/env-graph';
import type { Resolver } from '../../env-graph/lib/resolver';
import {
  LoadingError,
  ParseError,
  ResolutionError,
  SchemaError,
  VarlockError,
} from '../../env-graph/lib/errors';

/** npm-style package name (scoped or unscoped), conservative length */
const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const NPM_VERSION_RE = /^[\d]+(?:\.[\d]+)*(?:-[\w.-]+)?$/;
const TELEMETRY_IDENTIFIER_RE = /^[a-zA-Z][\w-]{0,63}$/;
const KNOWN_SOURCE_TYPES = new Set(['schema', 'example', 'defaults', 'values', 'overrides']);

/** Machine-friendly error category sent with telemetry (no messages or paths) */
export type TelemetryErrorCode = | 'parse_error'
  | 'plugin_error'
  | 'load_error'
  | 'schema_error'
  | 'resolution_error'
  | 'validation_error';

export type TelemetryPluginInfo = {
  /** Raw npm name for @varlock/* plugins; SHA-256 hex for all others */
  name: string;
  /** Semver for @varlock/* plugins; omitted (null) when name is hashed */
  version: string | null;
  type: 'single-file' | 'package';
  is_official: boolean;
  name_is_hashed: boolean;
  has_loading_error: boolean;
  warning_count: number;
};

export type TelemetryFeatureInfo = {
  settings: SerializedEnvGraph['settings'];
  cache_mode: 'auto' | 'memory' | 'disk' | 'disabled';
  resolver_names: Array<string>;
  root_decorator_names: Array<string>;
  source_type_counts: Record<string, number>;
  config_item_count: number;
};

export type TelemetryUsageContext = {
  integration: { name: string; version: string } | null;
  plugins: Array<TelemetryPluginInfo>;
  features: TelemetryFeatureInfo | null;
  graph_loaded: boolean;
  error_code: TelemetryErrorCode | null;
};

let sessionUsageContext: Pick<TelemetryUsageContext, 'plugins' | 'features'> = {
  plugins: [],
  features: null,
};

let sessionGraph: EnvGraph | undefined;
let sessionGraphLoaded = false;
/** Set when graph load throws before a graph instance is available */
let sessionLoadFailureErrorCode: TelemetryErrorCode | null = null;

let cachedIntegrationFromEnv: { name: string; version: string } | null | undefined;

function hashTelemetryValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isOfficialVarlockPackageName(name: string) {
  return name.startsWith('@varlock/');
}

function isBlockingError(err: VarlockError) {
  return !err.isWarning;
}

/** Classify a loaded graph's most significant blocking error (re-run at send time for post-resolve state) */
export function classifyGraphTelemetryErrorCode(graph: EnvGraph): TelemetryErrorCode | null {
  if (graph.plugins.some((p) => p.loadingError && isBlockingError(p.loadingError))) {
    return 'plugin_error';
  }

  for (const source of graph.sortedDataSources) {
    const loadingError = source.loadingError;
    if (loadingError instanceof ParseError && isBlockingError(loadingError)) {
      return 'parse_error';
    }

    for (const err of source.errors) {
      if (!isBlockingError(err)) continue;
      if (err instanceof ParseError) return 'parse_error';
      if (err instanceof LoadingError) return 'load_error';
      if (err instanceof SchemaError) return 'schema_error';
    }

    for (const err of source.resolutionErrors) {
      if (isBlockingError(err)) return 'resolution_error';
    }
  }

  for (const itemKey of graph.sortedConfigKeys) {
    if (graph.configSchema[itemKey].validationState === 'error') {
      return 'validation_error';
    }
  }

  return null;
}

/** Map thrown load failures (before a graph is returned) to an error code */
export function classifyThrownTelemetryErrorCode(err: unknown): TelemetryErrorCode {
  let current: unknown = err;
  while (current instanceof Error) {
    if (current instanceof ParseError) return 'parse_error';
    if (current instanceof SchemaError) return 'schema_error';
    if (current instanceof ResolutionError) return 'resolution_error';
    if (current instanceof LoadingError) return 'load_error';
    current = current.cause;
  }
  return 'load_error';
}

/** Only @varlock/* integration packages with npm-like name/version are accepted */
export function sanitizeIntegrationIdentity(
  integration: { name: string; version: string } | null,
): { name: string; version: string } | null {
  if (!integration) return null;
  const { name, version } = integration;
  if (
    name.length > 128
    || version.length > 32
    || !isOfficialVarlockPackageName(name)
    || !NPM_PACKAGE_NAME_RE.test(name)
  ) {
    return null;
  }
  if (version !== 'unknown' && !NPM_VERSION_RE.test(version)) return null;
  return { name, version };
}

/** Resolver/decorator identifiers must match a strict safe pattern; internal names are dropped */
export function sanitizeFeatureIdentifier(name: string): string | null {
  if (name.startsWith('\0')) return null;
  if (!TELEMETRY_IDENTIFIER_RE.test(name)) return null;
  return name;
}

/** @internal exported for unit tests */
export function sanitizePluginForTelemetry(plugin: {
  name: string;
  version: string;
  type: 'single-file' | 'package';
  loadingError?: unknown;
  warnings: Array<unknown>;
}): TelemetryPluginInfo {
  const isOfficial = isOfficialVarlockPackageName(plugin.name);
  const nameIsHashed = !isOfficial && plugin.name !== 'unnamed plugin';

  return {
    name: nameIsHashed ? hashTelemetryValue(plugin.name) : plugin.name,
    version: isOfficial ? plugin.version : null,
    type: plugin.type,
    is_official: isOfficial,
    name_is_hashed: nameIsHashed,
    has_loading_error: !!plugin.loadingError,
    warning_count: plugin.warnings.length,
  };
}

/** @internal convention: integrations set `__VARLOCK_INTEGRATION=name@version` before subprocess */
export function parseIntegrationFromEnv(
  envValue: string | undefined = process.env.__VARLOCK_INTEGRATION,
): { name: string; version: string } | null {
  if (!envValue?.trim()) return null;
  const trimmed = envValue.trim();
  if (trimmed.length > 160) return null;

  const at = trimmed.lastIndexOf('@');
  const parsed = at <= 0
    ? { name: trimmed, version: 'unknown' as const }
    : {
      name: trimmed.slice(0, at),
      version: trimmed.slice(at + 1) || 'unknown',
    };

  return sanitizeIntegrationIdentity(parsed);
}

function collectResolverNames(resolver: Resolver | undefined, names: Set<string>) {
  if (!resolver) return;
  const sanitized = sanitizeFeatureIdentifier(resolver.fnName);
  if (sanitized) names.add(sanitized);
  for (const child of resolver.arrArgs ?? []) collectResolverNames(child, names);
  for (const child of Object.values(resolver.objArgs ?? {})) collectResolverNames(child, names);
}

function countSourceTypes(sources: SerializedEnvGraph['sources']) {
  const counts: Record<string, number> = {};
  for (const source of sources) {
    if (!KNOWN_SOURCE_TYPES.has(source.type)) continue;
    counts[source.type] = (counts[source.type] ?? 0) + 1;
  }
  return counts;
}

export function captureUsageContextFromEnvGraph(graph: EnvGraph) {
  sessionGraph = graph;
  sessionGraphLoaded = true;
  sessionLoadFailureErrorCode = null;

  const serialized = graph.getSerializedGraph();
  const resolverNames = new Set<string>();
  for (const itemKey of graph.sortedConfigKeys) {
    collectResolverNames(graph.configSchema[itemKey].valueResolver, resolverNames);
  }

  const rootDecoratorNames = new Set<string>();
  for (const source of graph.sortedDataSources) {
    for (const dec of source.rootDecorators) {
      const sanitized = sanitizeFeatureIdentifier(dec.name);
      if (sanitized) rootDecoratorNames.add(sanitized);
    }
  }

  sessionUsageContext = {
    plugins: graph.plugins.map((p) => sanitizePluginForTelemetry(p)),
    features: {
      settings: serialized.settings,
      cache_mode: graph._cacheMode,
      resolver_names: [...resolverNames].sort(),
      root_decorator_names: [...rootDecoratorNames].sort(),
      source_type_counts: countSourceTypes(serialized.sources),
      config_item_count: graph.sortedConfigKeys.length,
    },
  };
}

/** Record a graph load failure before an EnvGraph instance is available */
export function captureTelemetryGraphLoadFailure(err: unknown) {
  sessionGraph = undefined;
  sessionGraphLoaded = false;
  sessionLoadFailureErrorCode = classifyThrownTelemetryErrorCode(err);
  sessionUsageContext = { plugins: [], features: null };
}

function resolveTelemetryErrorCode(): TelemetryErrorCode | null {
  if (sessionGraphLoaded && sessionGraph) {
    return classifyGraphTelemetryErrorCode(sessionGraph);
  }
  return sessionLoadFailureErrorCode;
}

export function getTelemetryUsageContext(): TelemetryUsageContext {
  if (cachedIntegrationFromEnv === undefined) {
    cachedIntegrationFromEnv = parseIntegrationFromEnv();
  }
  return {
    integration: cachedIntegrationFromEnv,
    plugins: sessionUsageContext.plugins,
    features: sessionUsageContext.features,
    graph_loaded: sessionGraphLoaded,
    error_code: resolveTelemetryErrorCode(),
  };
}

/** Flat PostHog properties derived from the session usage context */
export function getTelemetryUsageContextPayload(): Record<string, unknown> {
  const ctx = getTelemetryUsageContext();
  return {
    integration_name: ctx.integration?.name ?? null,
    integration_version: ctx.integration?.version ?? null,
    plugins: ctx.plugins,
    features: ctx.features,
    graph_loaded: ctx.graph_loaded,
    error_code: ctx.error_code,
  };
}

/** @internal test helper */
export function resetTelemetryUsageContextForTests() {
  sessionUsageContext = { plugins: [], features: null };
  sessionGraph = undefined;
  sessionGraphLoaded = false;
  sessionLoadFailureErrorCode = null;
  cachedIntegrationFromEnv = undefined;
}
