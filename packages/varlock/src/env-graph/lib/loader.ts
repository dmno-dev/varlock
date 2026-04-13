import fs from 'node:fs';
import path from 'node:path';
import _ from '@env-spec/utils/my-dash';
import { EnvGraph } from './env-graph';
import { DirectoryDataSource, DotEnvFileDataSource, MultiplePathsContainerDataSource } from './data-source';

export async function loadEnvGraph(opts?: {
  basePath?: string,
  /** Entry file path(s) — accepts a single path or array of paths */
  entryFilePaths?: string | Array<string>,
  relativePaths?: Array<string>,
  checkGitIgnored?: boolean,
  excludeDirs?: Array<string>,
  currentEnvFallback?: string,
  afterInit?: (graph: EnvGraph) => Promise<void>,
}) {
  const graph = new EnvGraph();

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

