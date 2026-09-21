/**
 * Marker env var set on a varlock CLI process spawned by `varlock/auto-load` or a framework
 * integration (via `execSyncVarlock`), so that a preloaded `varlock/auto-load` inside that CLI
 * process can tell it must not resolve again.
 *
 * Without it, bun's `bunfig.toml` `preload = ["varlock/auto-load"]` turns into a fork bomb:
 * bun preloads auto-load, which spawns the `varlock` CLI, whose `#!/usr/bin/env node` shebang
 * resolves to bun in a bun-only container (bun installs a `node` shim), and bun applies the cwd
 * bunfig preload to that CLI process too, which spawns another CLI, and so on forever.
 *
 * The CLI clears the marker from its own env as the very first thing it does (see
 * `cli/helpers/clear-cli-child-marker.ts`) so it never leaks to processes the CLI spawns
 * itself (`varlock run` children, exec() resolvers, plugins).
 */
export const CLI_CHILD_MARKER = '__VARLOCK_CLI_CHILD';

export function isVarlockCliChild(env: Record<string, string | undefined> = process.env): boolean {
  return !!env[CLI_CHILD_MARKER];
}
