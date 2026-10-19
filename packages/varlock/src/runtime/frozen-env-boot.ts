// Self-contained bundle that applies boot-time values for the `@dynamic=boot` items of a frozen
// env baked into a bundle (the bundle route). Framework integrations prepend it to their runtime
// files, before the init bundle, only when the frozen env they bake has boot items. The file and
// env var routes apply boot values CLI-side instead (see lib/injected-env-reuse).
//
// Kept out of the init bundles and `varlock/env` because checking a boot value needs the data
// type code, which most apps never need at runtime (and `varlock/env` also lands in client
// bundles). It registers itself on globalThis, and `initVarlockEnv` calls it for frozen graphs.
// Built with noExternal so it can be injected as raw JS.

import type { SerializedEnvGraph } from '../env-graph';
import { applyFrozenBootKeys } from '../lib/frozen-boot-keys';

/**
 * Apply boot-time values for a frozen env's `@dynamic=boot` items, checked against the types
 * recorded at freeze. Throws when one is invalid: a frozen env fails closed rather than booting
 * on a value nothing checked.
 */
export function applyFrozenBootValues(
  graph: SerializedEnvGraph,
  bootEnv: Record<string, string | undefined>,
): SerializedEnvGraph {
  const { graph: applied, problems } = applyFrozenBootKeys(graph, bootEnv);
  if (problems.length) {
    throw new Error([
      `[varlock] invalid @dynamic=boot value${problems.length === 1 ? '' : 's'} for the frozen env:`,
      ...problems.map((p) => `  - ${p}`),
      'Fix the value set in the environment at boot. It is checked against the type recorded when the env was frozen.',
    ].join('\n'));
  }
  return applied;
}

(globalThis as any).__varlockApplyFrozenBootValues = applyFrozenBootValues;
