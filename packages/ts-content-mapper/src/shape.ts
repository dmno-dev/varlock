// Builds the EnvGraph a type checker needs without running anything that reaches outside the process.
// `new EnvGraph({ mode: 'shape' })` does the work: only pure resolvers run (no exec(), no secret stores),
// root decorators are not executed, no cache store is created, plugins are never downloaded and process.env is
// ignored. What was skipped is listed in `graph.shapeSkipped`.
// The buffer is repaired first (see repair.ts), so a half-typed token still parses into the structure the
// lowering needs.
import path from 'node:path';
import { internal } from 'varlock';
import { loadRepaired, overrideText, type Repaired } from './repair';

const { EnvGraph, DotEnvFileDataSource } = internal;

export type ShapeGraph = InstanceType<typeof EnvGraph>;
export type ShapeLoadResult = {
  graph: ShapeGraph,
  source: any,
  repaired: Repaired,
  parseOk: boolean,
  loadError?: any,
  /** names of the resolvers shape mode did not run */
  skippedResolvers: Array<string>,
};

// keychain() and varlock() are only registered on the CLI's load path (lib/load-graph.ts), not on a bare EnvGraph.
// They are not pure, so shape mode would never run them anyway; registering stand-ins keeps schemas that use
// them valid and gives them a label for hover.
function cliOnlyResolvers(g: ShapeGraph) {
  const Base = Object.getPrototypeOf(g.registeredResolverFunctions.concat);
  const mk = (def: Record<string, unknown>) => class extends Base {
    static def = def;
  };
  const unreachable = () => {
    throw new Error('unreachable in shape mode');
  };
  return [
    mk({
      name: 'keychain',
      label: 'Read from macOS Keychain',
      icon: 'mdi:key-chain',
      impliesSensitive: true,
      argsSchema: { type: 'mixed', arrayMinLength: 0 },
      resolve: unreachable,
    }),
    mk({
      name: 'varlock',
      label: 'Decrypt locally encrypted value',
      impliesSensitive: true,
      argsSchema: { type: 'mixed', arrayMinLength: 0 },
      resolve: unreachable,
    }),
  ];
}

export function makeShapeGraph(): ShapeGraph {
  const g = new EnvGraph({ mode: 'shape' });
  for (const C of cliOnlyResolvers(g)) g.registerResolver(C as any);
  return g;
}

export async function loadShapeGraph(fileName: string, content: string): Promise<ShapeLoadResult> {
  return loadRepaired(content, async (repaired) => {
    const graph = makeShapeGraph();
    graph.basePath = path.dirname(fileName);
    const source = new DotEnvFileDataSource(fileName, { overrideContents: overrideText(repaired.text) });
    let loadError: unknown;
    try {
      await graph.setRootDataSource(source);
      await graph.finishLoad();
    } catch (e) {
      loadError = e;
    }
    const skippedResolvers = graph.shapeSkipped.filter((x) => x.kind === 'resolver').map((x) => x.name);
    return {
      graph, source, parseOk: !!source.parsedFile, loadError, skippedResolvers,
    };
  });
}
