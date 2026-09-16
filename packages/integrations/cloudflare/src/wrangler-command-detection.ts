/**
 * `wrangler preview` is two commands wearing one name: a deploy-style command
 * (`preview [script]`) that creates a branch preview, and a namespace for management
 * subcommands (`preview delete`, `preview secret put`, ...). Only the former should get
 * varlock's resolved vars and secrets injected.
 *
 * Telling them apart from raw argv means knowing which of wrangler's options take a value
 * (`preview --name delete` deploys a preview named "delete") and which subcommands exist -
 * and options may appear before the subcommand (`preview -c wrangler.jsonc delete`). Both
 * lists belong to wrangler and change between releases, so instead of mirroring them here
 * we let wrangler resolve the command itself: appending `--help` makes yargs print the
 * resolved command path as the first line of its output and exit without running anything.
 */

/** Runs `wrangler <args>`, resolving its combined output, or undefined if it could not run. */
export type WranglerRunner = (args: Array<string>) => Promise<string | undefined>;

const HELP_FLAGS = ['--help', '-h'];

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*m/g;

/**
 * Reads the command path out of wrangler's help output, e.g. `wrangler preview [script]`
 * -> `preview`, `wrangler preview settings update` -> `preview settings update`.
 * Returns undefined when the output isn't a usage banner (a parse error, an unknown
 * command, no wrangler at all).
 */
export function resolvedCommandFromHelp(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const firstLine = output.replace(ANSI_ESCAPE_RE, '').split('\n').map((line) => line.trim()).find(Boolean);
  if (!firstLine?.startsWith('wrangler ')) return undefined;
  // positional placeholders (`[script]`, `<key>`) are part of the usage line, not the path
  const path = firstLine.split(/\s+/).slice(1).filter((word) => !word.startsWith('[') && !word.startsWith('<'));
  if (!path.length) return undefined;
  return path.join(' ');
}

/**
 * Wrangler accepts global flags before the command (`wrangler --cwd=/app deploy`), so the
 * command is not always `args[0]`. Returns the args from the command onwards, or an empty
 * array if there is no command at all.
 *
 * Only the `--flag=value` form can precede the command: wrangler rejects the separated
 * form there (`wrangler --cwd /app deploy` fails with `Unknown argument: /app`), so the
 * first bare word is always the command, never some earlier flag's value.
 */
export function wranglerCommandArgs(args: Array<string>) {
  const commandIndex = args.findIndex((arg) => !arg.startsWith('-'));
  return commandIndex === -1 ? [] : args.slice(commandIndex);
}

/**
 * Whether these args are a preview *deployment* (as opposed to a preview management
 * subcommand, or something else entirely). Asks wrangler to resolve the command when the
 * args are ambiguous.
 */
export async function isPreviewDeployCommand(args: Array<string>, runWrangler: WranglerRunner) {
  // wrangler stops parsing options at `--`, so a subcommand can only appear before it -
  // and appending `--help` after it would make it a positional, running the command for real
  const doubleDashIndex = args.indexOf('--');
  const parsedArgs = doubleDashIndex === -1 ? args : args.slice(0, doubleDashIndex);

  const command = wranglerCommandArgs(parsedArgs);
  if (command[0] !== 'preview') return false;

  // let wrangler print its own help
  if (parsedArgs.some((arg) => HELP_FLAGS.includes(arg))) return false;

  // a subcommand is always a bare word, so with no positionals at all this can only be
  // the deploy command - no need to ask
  const hasPositional = command.slice(1).some((arg) => !arg.startsWith('-'));
  if (!hasPositional) return true;

  // probe with the leading global flags too: they can change which config wrangler reads
  const resolved = resolvedCommandFromHelp(await runWrangler([...parsedArgs, '--help']));
  // if wrangler couldn't tell us, pass the command through and let it report the problem
  return resolved === 'preview';
}
