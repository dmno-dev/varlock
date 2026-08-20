import { CliExitError } from './exit-error';
import { fmt } from './pretty-format';

// gunshi reports argument problems (unknown options under `strict`, bad enum/type values,
// unresolvable subcommands) as an AggregateError of structured errors, and renders them
// with `ctx.log` - i.e. stdout, which would corrupt the output of commands like
// `varlock load`. We set `renderValidationErrors: null` to suppress that and turn the
// error into a normal CliExitError here instead, so every failure looks the same and
// lands on stderr.

/** gunshi's resource key for an option that isn't declared by the resolved command */
const UNKNOWN_OPTION_CODE = 'err:arg:unknown-option';

type UnknownOptionError = {
  code: string;
  values: { rawName?: string, name?: string, candidates?: Array<string> };
};

type CommandNotFoundError = {
  commandName: string;
  candidates: Array<string>;
  /** parent path the lookup failed under: `['proxy']` for `varlock proxy strat`, `[]` at the top level */
  commandPath?: Array<string>;
};

/** gunshi's placeholder name for the unnamed entry command; never something to suggest */
const ANONYMOUS_COMMAND_NAME = '(anonymous)';

/**
 * Levenshtein distance, kept dependency-free for the "did you mean" suggestion.
 *
 * @internal exported for unit tests
 */
export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: Array<Array<number>> = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dist[i][0] = i;
  for (let j = 0; j < cols; j++) dist[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1,
        dist[i][j - 1] + 1,
        dist[i - 1][j - 1] + cost,
      );
    }
  }
  return dist[a.length][b.length];
}

const stripDashes = (value: string) => value.replace(/^--?/, '');

/**
 * Closest candidate within edit distance 2, or undefined when nothing is close enough.
 *
 * @internal exported for unit tests
 */
export function suggestClosest(typed: string, candidates: Array<string>, maxDistance = 2) {
  let best: { name: string, distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(stripDashes(typed), stripDashes(candidate));
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}

// Errors arrive from gunshi's own bundle, so `instanceof` against the classes re-exported
// by `gunshi/plugin` does not match them (the two ship separate copies of each class).
// Match on shape instead. See https://github.com/kazupon/gunshi/pull/678
function asUnknownOptionError(err: unknown): UnknownOptionError | undefined {
  if (!err || typeof err !== 'object') return;
  const candidate = err as UnknownOptionError;
  if (candidate.code !== UNKNOWN_OPTION_CODE) return;
  if (typeof candidate.values?.name !== 'string') return;
  return candidate;
}

function asCommandNotFoundError(err: unknown): CommandNotFoundError | undefined {
  if (!(err instanceof Error) || err.name !== 'CommandNotFoundError') return;
  const candidate = err as unknown as CommandNotFoundError;
  if (typeof candidate.commandName !== 'string') return;
  return candidate;
}

/**
 * The subcommand path the user typed, used to point them at the right `--help`.
 * Leading non-flag tokens only, so `proxy start --alow-reload` yields `proxy start`.
 */
export function commandPathFromArgs(args: Array<string>) {
  const path: Array<string> = [];
  for (const arg of args) {
    if (arg === '--' || arg.startsWith('-')) break;
    path.push(arg);
  }
  return path;
}

/** Does this error (or aggregate) come from gunshi's argument validation? */
export function isArgValidationError(err: unknown): err is AggregateError {
  return err instanceof AggregateError && Array.isArray(err.errors);
}

/**
 * Convert gunshi's AggregateError into varlock's standard error output, adding a
 * "did you mean" line when a declared flag or command is a near-match for what was typed.
 */
export function toCliExitError(error: AggregateError, args: Array<string>): CliExitError {
  const commandPath = commandPathFromArgs(args);
  const helpCommand = `varlock ${[...commandPath, '--help'].join(' ')}`.replace(/\s+/g, ' ');

  const unknownFlags: Array<string> = [];
  const details: Array<string> = [];
  let notFoundCommand: string | undefined;
  let notFoundParentPath: Array<string> = [];

  for (const err of error.errors) {
    const unknownOption = asUnknownOptionError(err);
    if (unknownOption) {
      const rawName = unknownOption.values.rawName ?? `--${unknownOption.values.name}`;
      unknownFlags.push(rawName);
      const suggestion = suggestClosest(rawName, unknownOption.values.candidates ?? []);
      if (suggestion) details.push(`Did you mean ${fmt.flag(suggestion)}?`);
      continue;
    }

    const commandNotFound = asCommandNotFoundError(err);
    if (commandNotFound) {
      notFoundCommand = commandNotFound.commandName;
      // the lookup happens under a parent path, so a bare candidate is not runnable on its
      // own: `varlock proxy strat` must suggest `varlock proxy start`, not `varlock start`
      notFoundParentPath = commandNotFound.commandPath ?? [];
      const candidates = (commandNotFound.candidates ?? []).filter((c) => c !== ANONYMOUS_COMMAND_NAME);
      const suggestion = suggestClosest(commandNotFound.commandName, candidates);
      if (suggestion) {
        const fullCommand = ['varlock', ...notFoundParentPath, suggestion].join(' ');
        details.push(`Did you mean ${fmt.command(fullCommand)}?`);
      }
      continue;
    }

    // anything else (bad enum value, wrong type, missing required arg) keeps gunshi's message
    if (err instanceof Error && err.message) details.push(err.message);
  }

  if (unknownFlags.length) {
    const label = unknownFlags.length === 1 ? 'Unknown flag' : 'Unknown flags';
    return new CliExitError(`${label}: ${unknownFlags.join(', ')}`, {
      details: details.length ? details : undefined,
      suggestion: `Run \`${fmt.command(helpCommand, { jsPackageManager: true })}\` to see the available flags.`,
    });
  }

  if (notFoundCommand !== undefined) {
    // point at the help for the level that actually failed (`varlock proxy --help`)
    const notFoundHelp = ['varlock', ...notFoundParentPath, '--help'].join(' ');
    return new CliExitError(`Invalid subcommand: ${notFoundCommand}`, {
      details: details.length ? details : undefined,
      suggestion: `Run \`${fmt.command(notFoundHelp, { jsPackageManager: true })}\` for more info.`,
    });
  }

  return new CliExitError('Invalid arguments', {
    details: details.length ? details : undefined,
    suggestion: `Run \`${fmt.command(helpCommand, { jsPackageManager: true })}\` to see the available options.`,
  });
}
