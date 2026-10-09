import type { EnvGraph, SerializedEnvGraph } from '../env-graph';
import type { CliItemFilter } from '../cli/helpers/item-filter';

/**
 * The producer of a frozen env: resolve a loaded graph the way a freeze does, and serialize it
 * into the one payload format every route carries (the `varlock freeze` file, the env var
 * route via `--out -`, and in future framework bundles). Encryption is left to the route.
 *
 * The graph is left resolved, so the caller can report its errors (a graph with errors must
 * never be shipped as a frozen env) before using the payload.
 *
 * Invariant: this never consults an existing frozen env, or re-freezing would read back the
 * previous artifact and values would never change again.
 */
export async function buildFrozenEnv(graph: EnvGraph, opts?: {
  /**
   * package.json `varlock.filter` scoping a shared schema to one package: the frozen env holds
   * only what it selects, and it is never applied again (a frozen env is final)
   */
  scopeFilter?: CliItemFilter,
}): Promise<{ payload: SerializedEnvGraph, bootKeys: Array<string> }> {
  const { scopeFilter } = opts ?? {};
  // a required `@dynamic=boot` item may be unset here: its value arrives at boot, where the
  // frozen env checks it. Everything else must resolve and validate as usual.
  graph.deferBootRequired = true;
  if (scopeFilter) await scopeFilter.resolveScoped(graph);
  else await graph.resolveEnvValues();
  const frozenKeys = scopeFilter
    ? scopeFilter.getFilterKeys(Object.values(graph.configSchema))
    : undefined;

  const payload = graph.getSerializedGraph(frozenKeys ? { filterKeys: frozenKeys } : undefined);
  payload.frozen = true;
  // Override provenance describes process.env overrides at the ORIGINAL invocation, so
  // consumers re-apply exactly those keys from their own environment. That makes sense for a
  // nested `varlock run`, but here it would mean any schema key that happened to be set in CI
  // becomes a key the deployment platform can override at runtime - a hole in the frozen env
  // itself. A frozen env has no parent invocation, so: no overrides.
  payload.overrideKeys = [];

  // the serialized form already carries each boot item's spec (`config[key].boot`)
  const bootKeys = Object.keys(payload.config).filter((k) => payload.config[k].boot);
  return { payload, bootKeys };
}
