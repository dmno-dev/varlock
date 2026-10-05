import type { EnvGraph, SerializedEnvGraph } from '../env-graph';
import { EmptyRequiredValueError } from '../env-graph/lib/errors';
import type { CliItemFilter } from '../cli/helpers/item-filter';
import { describeFrozenBootKey } from './frozen-boot-keys';

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
  if (scopeFilter) await scopeFilter.resolveScoped(graph);
  else await graph.resolveEnvValues();
  const frozenKeys = scopeFilter
    ? scopeFilter.getFilterKeys(Object.values(graph.configSchema))
    : undefined;

  // `@dynamic=boot` items (a platform-assigned PORT, pod identity) are frozen like everything
  // else, and the freeze-time value is their default, but the environment at boot may override
  // them (see frozen-boot-keys). So a required one may legitimately be unset here: its value
  // just has to arrive at boot. Its default must otherwise resolve and validate like any value.
  const bootKeys = graph.sortedConfigKeys.filter((k) => (
    graph.configSchema[k].isBootDynamic && (!frozenKeys || frozenKeys.has(k))
  ));
  for (const key of bootKeys) {
    const item = graph.configSchema[key];
    item.validationErrors = item.validationErrors?.filter((e) => !(e instanceof EmptyRequiredValueError));
    if (!item.validationErrors?.length) item.validationErrors = undefined;
  }

  const payload = graph.getSerializedGraph(frozenKeys ? { filterKeys: frozenKeys } : undefined);
  // marks the payload as a frozen env, and records what boot needs to check a boot-time value
  // for each `@dynamic=boot` item without the schema - see the SerializedEnvGraph type
  payload.frozen = {
    ...(bootKeys.length ? {
      boot: Object.fromEntries(bootKeys.map((key) => {
        const item = graph.configSchema[key];
        return [key, describeFrozenBootKey(item.dataType, item.isRequired)];
      })),
    } : {}),
  };

  // Override provenance describes process.env overrides at the ORIGINAL invocation, so
  // consumers re-apply exactly those keys from their own environment. That makes sense for a
  // nested `varlock run`, but here it would mean any schema key that happened to be set in CI
  // becomes a key the deployment platform can override at runtime - a hole in the frozen env
  // itself. A frozen env has no parent invocation, so: no overrides.
  payload.overrideKeys = [];

  return { payload, bootKeys };
}
