import { plugin } from 'gunshi/plugin';

import { trackCommand } from './helpers/telemetry';

// gunshi resolves the whole command tree up front and dispatches straight to the leaf
// command's run fn, so wrapping a top-level command spec never sees the verbs nested
// under it - `varlock proxy run` bypasses the `proxy` wrapper entirely. Every verb used
// to need its own trackCommand() call, which is a standing invitation to forget one (and
// all ten `proxy` verbs were in fact untracked until #1020).
//
// A command decorator wraps whatever gunshi actually resolved, at any depth, and
// ctx.commandPath carries the full path (`['proxy','run']`), so a new subcommand is
// tracked the moment it is registered - nothing to remember.

/** Commands whose invocations we intentionally do not track */
const SKIP_COMMANDS = new Set([
  // registered by @gunshi/plugin-completion and invoked on every shell tab-press
  'complete',
]);

export function commandTelemetry() {
  return plugin({
    id: 'varlock:command-telemetry',
    name: 'command-telemetry',
    setup(ctx) {
      ctx.decorateCommand((baseRunner) => async (cmdCtx) => {
        const command = ((cmdCtx as any).commandPath ?? []).join(' ');
        // no path means bare `varlock` (the entry command), which just prints a pointer
        // to --help; `--help` and `--version` never reach here at all, since gunshi's
        // builtin global-options decorator wraps this one and returns before it.
        if (command && !SKIP_COMMANDS.has(command)) {
          // fired before the command runs so it is recorded even if the command never
          // returns (a long-lived child, a daemon, a hard exit) - see trackCommand
          await trackCommand(command);
        }
        return baseRunner(cmdCtx);
      });
    },
  });
}
