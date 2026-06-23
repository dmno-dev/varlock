import fs from 'node:fs';
import path from 'node:path';
import _ from '@env-spec/utils/my-dash';
import { EnvGraph } from './env-graph';
import { DirectoryDataSource, DotEnvFileDataSource, MultiplePathsContainerDataSource } from './data-source';
import {
  CacheStore, InMemoryCacheStore, createEnvKeyCacheStore, getCacheEnvKey,
} from '../../lib/cache';
import * as localEncrypt from '../../lib/local-encrypt';
import { createDebug } from '../../lib/debug';

const debug = createDebug('varlock:loader');

export async function loadEnvGraph(opts?: {
  basePath?: string,
  /** Entry file path(s) — accepts a single path or array of paths */
  entryFilePaths?: string | Array<string>,
  /** Explicit process.env override values used for config item override precedence */
  overrideValues?: Record<string, string | undefined>,
  /** Explicit process.env values used by builtin var detection */
  processEnvOverride?: Record<string, string | undefined>,
  relativePaths?: Array<string>,
  checkGitIgnored?: boolean,
  excludeDirs?: Array<string>,
  currentEnvFallback?: string,
  clearCache?: boolean,
  skipCache?: boolean,
  afterInit?: (graph: EnvGraph) => Promise<void>,
}) {
  const graph = new EnvGraph();
  if (opts?.overrideValues) graph.overrideValues = opts.overrideValues;
  if (opts?.processEnvOverride) graph.processEnvOverride = opts.processEnvOverride;

  // set cache mode flags
  if (opts?.clearCache) graph._clearCacheMode = true;
  if (opts?.skipCache) graph._skipCacheMode = true;

  let rawPaths: Array<string> | undefined;
  if (opts?.entryFilePaths) {
    rawPaths = Array.isArray(opts.entryFilePaths) ? opts.entryFilePaths : [opts.entryFilePaths];
  }

  if (rawPaths && rawPaths.length > 1) {
    graph.basePath = opts?.basePath ?? process.cwd();
    if (opts?.afterInit) await opts.afterInit(graph);
    if (opts?.currentEnvFallback) graph.envFlagFallback = opts.currentEnvFallback;
    const resolvedPaths = rawPaths.map((p) => path.resolve(p));
    await graph.setRootDataSource(new MultiplePathsContainerDataSource(resolvedPaths));
  } else if (rawPaths?.length === 1) {
    const entryFilePath = rawPaths[0];
    const resolvedPath = path.resolve(entryFilePath);
    const isDirectory = entryFilePath.endsWith('/') || entryFilePath.endsWith(path.sep)
      || (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory());
    if (isDirectory) {
      graph.basePath = resolvedPath;
      if (opts?.afterInit) await opts.afterInit(graph);
      if (opts?.currentEnvFallback) graph.envFlagFallback = opts.currentEnvFallback;
      await graph.setRootDataSource(new DirectoryDataSource(resolvedPath));
    } else {
      graph.basePath = path.dirname(resolvedPath);
      if (opts?.afterInit) await opts.afterInit(graph);
      if (opts?.currentEnvFallback) graph.envFlagFallback = opts.currentEnvFallback;
      await graph.setRootDataSource(new DotEnvFileDataSource(resolvedPath));
    }
  } else {
    graph.basePath = opts?.basePath ?? process.cwd();
    if (opts?.afterInit) await opts.afterInit(graph);
    if (opts?.currentEnvFallback) graph.envFlagFallback = opts.currentEnvFallback;
    await graph.setRootDataSource(new DirectoryDataSource(graph.basePath));
  }

  // Pick up any `_VARLOCK_*` config vars set as static values in the now-parsed .env files
  // (e.g. an `_VARLOCK_CACHE_KEY` in `.env.local`) so they can configure varlock itself. A
  // real env var still wins — see `graph.varlockConfigEnv`. Runs once (finishLoad's call is a
  // no-op after this); disabled/env flags are already settled here.
  graph.processVarlockConfigVarsFromFiles({ emitDiagnostics: true });

  // initialize cache store (encryption key is ensured lazily on first write)
  // auto policy: native-backend disk > env-key disk > in-process memory
  // NOTE: runs after parsing so the cache key can come from a .env file; this means values
  // resolved during early init (envFlag/@disable/@import) are not disk-cached, which is fine.
  const envKey = getCacheEnvKey(graph.varlockConfigEnv);

  // --clear-cache always clears the persistent disk cache(s), even when combined
  // with --skip-cache or when the active store for this run is memory-backed
  if (opts?.clearCache) {
    const diskStores = [new CacheStore()];
    if (envKey) {
      try {
        diskStores.push(createEnvKeyCacheStore(envKey));
      } catch {
        // invalid env key — nothing to clear for it
      }
    }
    for (const store of diskStores) {
      if (fs.existsSync(store.getFilePath())) await store.clearAll();
    }
  }

  if (!opts?.skipCache) {
    const backend = localEncrypt.getBackendInfo();
    const isCi = graph.ciEnvInfo.isCI;
    if (backend.type !== 'file' && !isCi) {
      graph._cacheMode = 'disk';
      graph._cacheStore = new CacheStore();
    } else if (envKey) {
      // _VARLOCK_CACHE_KEY (e.g. provided as a CI secret) enables disk caching
      // without the encryption key ever touching disk
      try {
        graph._cacheStore = createEnvKeyCacheStore(envKey);
        graph._cacheMode = 'disk';
      } catch (err) {
        debug('invalid %s — falling back to memory cache: %O', '_VARLOCK_CACHE_KEY', err);
        graph._cacheMode = 'memory';
        graph._cacheStore = new InMemoryCacheStore();
      }
    } else {
      graph._cacheMode = 'memory';
      graph._cacheStore = new InMemoryCacheStore();
    }
  }

  await graph.finishLoad();

  return graph;
}

/**
 * Lightweight, parse-only extraction of `_VARLOCK_*` config vars set as static values in a
 * directory's `.env` files. Skips full resolution (and the cache), so callers that only need
 * varlock's own config — e.g. the `cache` command — can read it without the cost or potential
 * recursion of a full graph load. Returns `{}` if the files can't be parsed.
 */
export async function loadVarlockConfigVarsFromFiles(basePath: string): Promise<Record<string, string>> {
  const graph = new EnvGraph();
  graph.basePath = basePath;
  try {
    await graph.setRootDataSource(new DirectoryDataSource(basePath));
  } catch {
    return {};
  }
  return graph.processVarlockConfigVarsFromFiles();
}
