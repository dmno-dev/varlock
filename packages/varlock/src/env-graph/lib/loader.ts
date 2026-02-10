import path from 'node:path';
import _ from '@env-spec/utils/my-dash';
import { EnvGraph } from './env-graph';
import { DirectoryDataSource, DotEnvFileDataSource } from './data-source';

export async function loadEnvGraph(opts?: {
  basePath?: string,
  entryFilePath?: string,
  relativePaths?: Array<string>,
  checkGitIgnored?: boolean,
  excludeDirs?: Array<string>,
  currentEnvFallback?: string,
  afterInit?: (graph: EnvGraph) => Promise<void>,
}) {
  const graph = new EnvGraph();

  if (opts?.entryFilePath) {
    const resolvedPath = path.resolve(opts.entryFilePath);
    if (opts.entryFilePath.endsWith('/') || opts.entryFilePath.endsWith(path.sep)) {
      // trailing slash means treat as directory
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

