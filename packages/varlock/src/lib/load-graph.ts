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
import { parseBlobOverrideKeys, selectOverrideValuesFromEnv } from './injected-env-provenance';
import { getActiveProxySession, getProxyResolutionViewForEnv } from '../proxy/session-registry';
import { PROXY_CHILD_ENV_VAR } from '../proxy/env-vars';
import { enforceProxySchemaFingerprint } from '../cli/helpers/proxy-schema-fingerprint';

const debug = createDebug('varlock:load');

function getGraphEnvOverridesFromRuntimeEnv() {
  const overrideKeys = parseBlobOverrideKeys(process.env.__VARLOCK_ENV);
  if (!overrideKeys) return undefined;
  return selectOverrideValuesFromEnv(process.env, overrideKeys);
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
}) {
  const runtimeOverrideValues = getGraphEnvOverridesFromRuntimeEnv();

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
        currentEnvFallback: opts?.currentEnvFallback,
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
        currentEnvFallback: opts?.currentEnvFallback,
        overrideValues: runtimeOverrideValues,
        clearCache: opts?.clearCache,
        skipCache: opts?.skipCache,
        proxyResolutionView,
      });
    }

    debug('no path configured, using cwd: %s', process.cwd());

    return captureUsageAfterLoad(runWithWorkspaceInfo(() => loadEnvGraph({
      currentEnvFallback: opts?.currentEnvFallback,
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

  return graph;
}
