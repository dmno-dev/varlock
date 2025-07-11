import _ from '@env-spec/utils/my-dash';
import { EnvGraph } from './env-graph';
import { DotEnvFileDataSource, ProcessEnvDataSource } from './data-source';
import { findEnvFiles } from '@env-spec/utils/find-env-files';

function autoDetectContextPath() {
  const PWD = process.env.PWD;
  if (!PWD) {
    throw new Error('PWD is not set');
  }
  return PWD;
}


export async function loadEnvGraph(opts?: {
  contextPath?: string,
  relativePaths?: Array<string>,
  checkGitIgnored?: boolean,
  excludeDirs?: Array<string>,
  currentEnvFallback?: string,
  afterInit?: (graph: EnvGraph) => Promise<void>,
}) {
  const contextPath = opts?.contextPath ?? autoDetectContextPath();

  const graph = new EnvGraph();
  graph.basePath = contextPath;

  if (opts?.afterInit) {
    await opts.afterInit(graph);
  }

  if (opts?.currentEnvFallback) {
    graph.envFlagValue = opts.currentEnvFallback;
  }

  const envFilePaths = await findEnvFiles({
    cwd: contextPath,
  });

  for (const envFilePath of envFilePaths) {
    const fileDataSource = new DotEnvFileDataSource(envFilePath);
    // must call before finishInit so the dataSource has a reference to the graph
    graph.addDataSource(fileDataSource);
    await fileDataSource.finishInit();
  }
  // proocss.env overrides get some special treatment
  graph.finalOverridesDataSource = new ProcessEnvDataSource();

  await graph.finishLoad();

  return graph;
}

