import fs from 'node:fs';
import path from 'node:path';
import _ from '@env-spec/utils/my-dash';
import { EnvGraph } from './env-graph';
import { DirectoryDataSource, DotEnvFileDataSource, MultiplePathsContainerDataSource } from './data-source';
import { CacheStore } from '../../lib/cache';
import * as localEncrypt from '../../lib/local-encrypt';

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

  // initialize cache store (graceful — if encryption key doesn't exist, skip caching)
  if (!opts?.skipCache) {
    try {
      await localEncrypt.ensureKey();
      graph._cacheStore = new CacheStore();
      if (graph._clearCacheMode) {
        graph._cacheStore.clearAll();
      }
    } catch {
      // cache unavailable — proceed without caching
    }
  }

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

  await graph.finishLoad();

  return graph;
}
