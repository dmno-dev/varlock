import fs from 'node:fs';
import path from 'node:path';
import { loadEnvGraph, type EnvGraph, type ProxyResolutionView } from '../env-graph';
import { VarlockResolver } from './local-encrypt/builtin-resolver';
import { KeychainResolver } from './local-encrypt/keychain-resolver';
import { CliExitError } from '../cli/helpers/exit-error';
import { captureUsageContextFromEnvGraph, captureTelemetryGraphLoadFailure } from '../cli/helpers/telemetry-usage-context';
import { runWithWorkspaceInfo } from './workspace-utils';
import { readVarlockPackageJsonConfig } from './package-json-config';
import { createDebug } from './debug';
import { injectedEnvStringForm, selectOverridesFromInjectedEnv } from './injected-env-provenance';
import { getPinnedBootKeys, type PinnedGraphInfo } from './injected-env-reuse';
import { USE_FROZEN_ENV_VAR } from './frozen-env-file';
import { isVarlockReservedKey } from '../env-graph/lib/reserved-vars';
import { getPreInjectionProcessEnv } from '../runtime/env';
import { getActiveProxySession, getProxyResolutionViewForEnv } from '../proxy/session-registry';
import { PROXY_CHILD_ENV_VAR } from '../proxy/env-vars';
import { enforceProxySchemaFingerprint } from '../cli/helpers/proxy-schema-fingerprint';

const debug = createDebug('varlock:load');

function getGraphEnvOverridesFromRuntimeEnv() {
  // Select from the pre-injection process.env snapshot, not the live one: the
  // runtime auto-init re-injects the parent blob's resolved values into
  // process.env, which would otherwise clobber a command-local override
  // (`FOO=bar varlock ...`) back to the parent's value when a nested `varlock`
  // runs under a parent `varlock run`. Overrides are the blob's recorded override
  // keys plus any env value that diverged from what the parent injected (an
  // override introduced after the parent resolved).
  return selectOverridesFromInjectedEnv(process.env.__VARLOCK_ENV, getPreInjectionProcessEnv());
}

/**
 * Override values for a resolution applied on top of a pinned graph (`varlock freeze` output
 * that leaves `@dynamic=boot` keys to be resolved at boot).
 *
 * Every pinned key becomes an override holding its frozen value, which the graph treats
 * exactly like a process.env override: the item's own resolver never runs (so no resolver
 * credentials are needed for pinned secrets) while its validators still do. Boot keys are
 * the only ones that read the live environment, and only from the pre-injection snapshot
 * for the same reason getGraphEnvOverridesFromRuntimeEnv uses it. Nothing else in the
 * environment can act as an override: the seal on pinned keys stays total.
 */
function getGraphEnvOverridesFromPinnedGraph(pinned: PinnedGraphInfo) {
  const overrides: Record<string, string | undefined> = {};
  const runtimeEnv = getPreInjectionProcessEnv();
  for (const bootKey of getPinnedBootKeys(pinned.graph)) {
    if (bootKey in runtimeEnv) overrides[bootKey] = runtimeEnv[bootKey];
  }
  for (const [itemKey, item] of Object.entries(pinned.graph.config)) {
    // a key frozen as unset stays unset (undefined, never '' - the item may not even allow
    // empty), so it still masks any ambient value the way the full-reuse path does
    overrides[itemKey] = item.value === undefined ? undefined : injectedEnvStringForm(item);
  }
  return overrides;
}

function describePinnedSource(pinned: PinnedGraphInfo) {
  return pinned.source === 'frozen-file' ? `frozen env file ${pinned.filePath}` : 'frozen __VARLOCK_ENV payload';
}

/**
 * A pinned graph is only valid against the schema it was frozen from. Fail closed on any
 * drift rather than resolving whatever is missing fresh: a key added to the schema since
 * the freeze would otherwise be silently resolved at boot (needing credentials the runtime
 * is not supposed to have, or worse, quietly succeeding with a different value), and a
 * boot-key mismatch means the file and the schema disagree about what is pinned at all.
 */
function verifyPinnedGraphMatchesSchema(graph: EnvGraph, pinned: PinnedGraphInfo) {
  // a schema that failed to load reports its own errors; a drift report on top would be noise
  if (graph.sortedDataSources.some((s) => !s.isValid)) return;

  const schemaKeys = graph.sortedConfigKeys.filter(
    (k) => !isVarlockReservedKey(k) && !graph.configSchema[k].isInternal,
  );
  const schemaBootKeys = schemaKeys.filter((k) => graph.configSchema[k].isBootDynamic);
  const pinnedKeys = Object.keys(pinned.graph.config);
  const pinnedBootKeys = getPinnedBootKeys(pinned.graph);

  const problems: Array<string> = [];
  const missing = schemaKeys.filter((k) => !pinnedKeys.includes(k) && !pinnedBootKeys.includes(k));
  if (missing.length) problems.push(`not in the pin: ${missing.join(', ')}`);
  const extra = pinnedKeys.filter((k) => !schemaKeys.includes(k));
  if (extra.length) problems.push(`pinned but no longer in the schema: ${extra.join(', ')}`);
  const bootOnlyInSchema = schemaBootKeys.filter((k) => !pinnedBootKeys.includes(k));
  const bootOnlyInPin = pinnedBootKeys.filter((k) => !schemaBootKeys.includes(k));
  if (bootOnlyInSchema.length) problems.push(`@dynamic=boot in the schema but pinned: ${bootOnlyInSchema.join(', ')}`);
  if (bootOnlyInPin.length) problems.push(`left to boot by the pin but not @dynamic=boot in the schema: ${bootOnlyInPin.join(', ')}`);
  if (!problems.length) return;

  throw new CliExitError(`The ${describePinnedSource(pinned)} does not match the schema`, {
    suggestion: [
      ...problems.map((p) => `- ${p}`),
      'Re-run `varlock freeze` against the current schema and redeploy, or set '
        + `${USE_FROZEN_ENV_VAR}=0 to resolve from .env files instead.`,
    ].join('\n'),
  });
}

function normalizePkgLoadPath(pkgLoadPath: string | Array<string>): Array<string> {
  if (Array.isArray(pkgLoadPath)) return pkgLoadPath;
  return [pkgLoadPath];
}

function captureUsageAfterLoad(promise: Promise<EnvGraph>) {
  return promise
    .then((graph) => {
      // telemetry capture must never turn a successful load into a failure
      try {
        captureUsageContextFromEnvGraph(graph);
      } catch { /* swallow - telemetry is best-effort */ }
      return graph;
    })
    .catch((err) => {
      try {
        captureTelemetryGraphLoadFailure(err);
      } catch { /* swallow - telemetry is best-effort */ }
      throw err;
    });
}

function loadFromPaths(
  rawPaths: Array<string>,
  config: {
    source: string,
    errorPrefix: string,
    errorSuggestion: string,
    currentEnvFallback?: string,
    overrideValues?: Record<string, string | undefined>,
    clearCache?: boolean,
    skipCache?: boolean,
    proxyResolutionView?: ProxyResolutionView,
  },
) {
  const resolvedPaths = rawPaths.map((p) => path.resolve(p));

  if (resolvedPaths.length === 1) {
    debug('using path from %s: %s', config.source, resolvedPaths[0]);
  } else {
    debug('using %d paths from %s: %s', resolvedPaths.length, config.source, resolvedPaths.join(', '));
  }

  for (const resolvedPath of resolvedPaths) {
    if (!fs.existsSync(resolvedPath)) {
      const err = new CliExitError(`${config.errorPrefix}: ${resolvedPath}`, {
        suggestion: config.errorSuggestion,
      });
      captureTelemetryGraphLoadFailure(err);
      throw err;
    }
  }

  return captureUsageAfterLoad(runWithWorkspaceInfo(() => loadEnvGraph({
    currentEnvFallback: config.currentEnvFallback,
    entryFilePaths: resolvedPaths,
    overrideValues: config.overrideValues,
    processEnvOverride: config.overrideValues,
    clearCache: config.clearCache,
    skipCache: config.skipCache,
    afterInit: async (g) => {
      g.registerResolver(VarlockResolver);
      g.registerResolver(KeychainResolver);
      if (config.proxyResolutionView) {
        g.proxyResolutionView = config.proxyResolutionView;
      }
    },
  })));
}

export async function loadVarlockEnvGraph(opts?: {
  currentEnvFallback?: string,
  /** Explicit entry file paths from --path flag(s) - overrides package.json config */
  entryFilePaths?: Array<string>,
  /** Clear cache and re-resolve all values */
  clearCache?: boolean,
  /** Skip cache entirely for this invocation */
  skipCache?: boolean,
  /**
   * Skip the proxy schema-fingerprint guard for this load. Used by the `proxy`
   * command itself (it manages the session fingerprint directly), so that
   * `proxy reload` can apply a schema change without being blocked by the
   * very guard it exists to clear.
   */
  skipProxyFingerprintGuard?: boolean,
  /**
   * Resolve on top of a pinned graph (`varlock freeze` output): every pinned key keeps its
   * frozen value (its resolver never runs, validators still do) and only the pin's
   * `@dynamic=boot` keys are resolved from the runtime. The schema must match the pin
   * exactly; any drift is an error.
   */
  pinned?: PinnedGraphInfo,
}) {
  const runtimeOverrideValues = opts?.pinned
    ? getGraphEnvOverridesFromPinnedGraph(opts.pinned)
    : getGraphEnvOverridesFromRuntimeEnv();
  // the pin records which environment it froze, so a schema relying on `--env` (no
  // @currentEnv) selects the same env files at boot without being told again
  const currentEnvFallback = opts?.currentEnvFallback ?? opts?.pinned?.graph.frozen?.currentEnv;
  if (opts?.pinned) {
    debug(
      'resolving on top of %s (%d pinned, boot keys: %s)',
      describePinnedSource(opts.pinned),
      Object.keys(opts.pinned.graph.config).length,
      getPinnedBootKeys(opts.pinned.graph).join(', ') || 'none',
    );
  }

  // Fail closed: if this process is a proxy child (the injected `__VARLOCK_PROXY_CHILD`
  // marker is the reliable in-tree signal) but its session record can't be resolved
  // — missing, corrupt, or otherwise unreadable — we have no placeholder/omit overlay
  // to apply, so resolving would re-expose REAL secrets. Refuse rather than leak.
  // (The daemon and `proxy` command itself never carry this marker, so they're
  // unaffected; only an actual proxied child is.)
  if (process.env[PROXY_CHILD_ENV_VAR] === '1' && !(await getActiveProxySession())) {
    throw new CliExitError('Proxy session record is unavailable', {
      suggestion: 'The proxy session that launched this process can no longer be read '
        + '(it may have been stopped, or its record corrupted). Re-run inside an active '
        + '`varlock proxy run` / `varlock proxy start` session.',
    });
  }

  const proxyResolutionView = await getProxyResolutionViewForEnv().catch(() => undefined);
  if (proxyResolutionView) {
    debug('applying proxy resolution view (%d item(s))', Object.keys(proxyResolutionView).length);
  }

  const cliPaths = opts?.entryFilePaths?.filter(Boolean);

  const graph = await (async () => {
    // If --path flag(s) provided, they take precedence over package.json config
    if (cliPaths && cliPaths.length > 0) {
      return loadFromPaths(cliPaths, {
        source: '--path flag',
        errorPrefix: 'The --path value does not exist',
        errorSuggestion: 'Use `--path` to specify a valid file or directory.',
        currentEnvFallback,
        overrideValues: runtimeOverrideValues,
        clearCache: opts?.clearCache,
        skipCache: opts?.skipCache,
        proxyResolutionView,
      });
    }

    // Fall back to package.json varlock.loadPath
    const pkgLoadPath = readVarlockPackageJsonConfig()?.loadPath;
    const pkgLoadPaths = pkgLoadPath ? normalizePkgLoadPath(pkgLoadPath) : undefined;

    if (pkgLoadPaths) {
      return loadFromPaths(pkgLoadPaths, {
        source: 'package.json varlock.loadPath',
        errorPrefix: 'A path in `varlock.loadPath` configured in package.json does not exist',
        errorSuggestion: 'Update `varlock.loadPath` in your package.json to point to valid files or directories.',
        currentEnvFallback,
        overrideValues: runtimeOverrideValues,
        clearCache: opts?.clearCache,
        skipCache: opts?.skipCache,
        proxyResolutionView,
      });
    }

    debug('no path configured, using cwd: %s', process.cwd());

    return captureUsageAfterLoad(runWithWorkspaceInfo(() => loadEnvGraph({
      currentEnvFallback,
      overrideValues: runtimeOverrideValues,
      processEnvOverride: runtimeOverrideValues,
      clearCache: opts?.clearCache,
      skipCache: opts?.skipCache,
      afterInit: async (g) => {
        g.registerResolver(VarlockResolver);
        g.registerResolver(KeychainResolver);
        if (proxyResolutionView) {
          g.proxyResolutionView = proxyResolutionView;
        }
      },
    })));
  })();

  if (!opts?.skipProxyFingerprintGuard) {
    await enforceProxySchemaFingerprint(graph);
  }

  if (opts?.pinned) verifyPinnedGraphMatchesSchema(graph, opts.pinned);

  return graph;
}
