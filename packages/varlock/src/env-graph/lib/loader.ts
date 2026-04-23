import fs from 'node:fs';
import path from 'node:path';
import _ from '@env-spec/utils/my-dash';
import { EnvGraph } from './env-graph';
import { DirectoryDataSource, DotEnvFileDataSource } from './data-source';
import { CacheStore } from '../../lib/cache';
import * as localEncrypt from '../../lib/local-encrypt';

export async function loadEnvGraph(opts?: {
  basePath?: string,
  entryFilePath?: string,
  relativePaths?: Array<string>,
  checkGitIgnored?: boolean,
  excludeDirs?: Array<string>,
  currentEnvFallback?: string,
  clearCache?: boolean,
  skipCache?: boolean,
  afterInit?: (graph: EnvGraph) => Promise<void>,
}) {
  const graph = new EnvGraph();

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

  if (opts?.entryFilePath) {
    const resolvedPath = path.resolve(opts.entryFilePath);
    const isDirectory = opts.entryFilePath.endsWith('/') || opts.entryFilePath.endsWith(path.sep)
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

