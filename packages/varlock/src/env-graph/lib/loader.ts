import _ from '@env-spec/utils/my-dash';
import { EnvGraph } from './env-graph';
import { DirectoryDataSource } from './data-source';

function autoDetectBasePath() {
  const PWD = process.env.PWD;
  if (!PWD) {
    throw new Error('PWD is not set');
  }
  return PWD;
}


export async function loadEnvGraph(opts?: {
  basePath?: string,
  relativePaths?: Array<string>,
  checkGitIgnored?: boolean,
  excludeDirs?: Array<string>,
  currentEnvFallback?: string,
  afterInit?: (graph: EnvGraph) => Promise<void>,
}) {
  const graph = new EnvGraph();
  graph.basePath = opts?.basePath ?? autoDetectBasePath();

  if (opts?.afterInit) {
    await opts.afterInit(graph);
  }

  if (opts?.currentEnvFallback) {
    graph.envFlagFallback = opts.currentEnvFallback;
  }

  await graph.setRootDataSource(new DirectoryDataSource(graph.basePath));
  await graph.finishLoad();

  return graph;
}

