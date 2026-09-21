import { CLI_CHILD_MARKER } from '../../lib/cli-child-marker';

/**
 * Side-effect module: must be the FIRST import of the CLI entrypoint.
 *
 * The `__VARLOCK_CLI_CHILD` marker exists only for a preloaded `varlock/auto-load` (bun's
 * bunfig `preload`) running inside this CLI process to see. Anything the CLI itself spawns
 * (`varlock run` children, exec() resolvers, plugin subprocesses) must NOT inherit it, or
 * their own auto-load would skip resolving and they would start with no env.
 *
 * The runtime's pre-injection snapshot of process.env (`globalThis.__varlockEnvState`,
 * see runtime/env.ts) is scrubbed as well: a preloaded auto-load has already imported the
 * runtime and captured the snapshot with the marker in it, and `varlock run` may build the
 * child env from that snapshot rather than the live process.env.
 */
export function clearCliChildMarker() {
  delete process.env[CLI_CHILD_MARKER];
  const envState = (globalThis as any).__varlockEnvState;
  if (envState?.originalProcessEnv) delete envState.originalProcessEnv[CLI_CHILD_MARKER];
}

clearCliChildMarker();
