import { plugin, type ArgToken, type Args } from 'gunshi/plugin';

import { CliExitError } from './helpers/exit-error';
import { fmt } from './helpers/pretty-format';

// gunshi silently ignores unknown/misspelled flags (there is no built-in strict
// option). This plugin decorates every command and rejects any option token that
// does not map to a declared arg, so a typo like `--alow-reload` errors loudly
// instead of being dropped.

// flags that gunshi handles itself and that every command implicitly accepts
const ALWAYS_ALLOWED = new Set(['help', 'h', 'version', 'v']);

// commands whose flags we intentionally do not police (internal / dynamic surface)
const SKIP_COMMANDS = new Set(['complete']);

function camelToKebab(name: string) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Levenshtein distance, kept dependency-free for the "did you mean" suggestion. */
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

interface KnownFlags {
  /** long names as typed on the CLI (kebab-case), used for matching and suggestions */
  long: Set<string>;
  /** single-character short aliases */
  short: Set<string>;
}

/** Build the set of accepted flag names from a command's declared arg schema. */
export function buildKnownFlags(args: Args | undefined): KnownFlags {
  const long = new Set<string>();
  const short = new Set<string>();
  for (const [argName, schema] of Object.entries(args ?? {})) {
    if (!schema || schema.type === 'positional') continue;
    const kebab = camelToKebab(argName);
    long.add(argName);
    long.add(kebab);
    if (schema.negatable) {
      long.add(`no-${argName}`);
      long.add(`no-${kebab}`);
    }
    if (schema.short) short.add(schema.short);
  }
  return { long, short };
}

/**
 * Walk the parsed tokens and return the raw names (e.g. `--alow-reload`) of any
 * option that is not declared by the command. Only option tokens before the `--`
 * terminator are checked, so child-process passthrough (`run`/`proxy run`) is
 * never rejected.
 */
export function findUnknownFlags(tokens: Array<ArgToken>, args: Args | undefined): Array<string> {
  const known = buildKnownFlags(args);
  const unknown: Array<string> = [];
  for (const token of tokens) {
    if (token.kind === 'option-terminator') break;
    if (token.kind !== 'option') continue;
    const name = token.name;
    if (!name) continue;
    if (ALWAYS_ALLOWED.has(name)) continue;
    // short aliases arrive as a single character (e.g. `-p` => name `p`)
    if (name.length === 1 && known.short.has(name)) continue;
    if (known.long.has(name)) continue;
    unknown.push(token.rawName ?? `--${name}`);
  }
  return unknown;
}

/** Closest declared long flag within edit distance 2, formatted as `--name`. */
export function suggestFlag(rawName: string, args: Args | undefined): string | undefined {
  const typed = rawName.replace(/^-+/, '').replace(/^no-/, '');
  const candidates = [...buildKnownFlags(args).long];
  let best: { name: string, distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(typed, candidate);
    if (distance <= 2 && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best ? `--${best.name}` : undefined;
}

/** Throw a CliExitError if the command was invoked with any unrecognized flag. */
export function assertNoUnknownFlags(ctx: { name?: string, tokens?: Array<ArgToken>, args?: Args }) {
  if (ctx.name && SKIP_COMMANDS.has(ctx.name)) return;
  const tokens = ctx.tokens ?? [];
  const unknown = findUnknownFlags(tokens, ctx.args);
  if (unknown.length === 0) return;

  const label = unknown.length === 1 ? 'Unknown flag' : 'Unknown flags';
  const suggestions: Array<string> = [];
  for (const rawName of unknown) {
    const suggestion = suggestFlag(rawName, ctx.args);
    if (suggestion) suggestions.push(`Did you mean ${fmt.flag(suggestion)}?`);
  }

  const helpCommand = ctx.name ? `varlock ${ctx.name} --help` : 'varlock --help';
  throw new CliExitError(`${label}: ${unknown.join(', ')}`, {
    details: suggestions.length ? suggestions : undefined,
    suggestion: `Run \`${fmt.command(helpCommand, { jsPackageManager: true })}\` to see the available flags.`,
  });
}

/** gunshi plugin that rejects unknown/misspelled flags on every subcommand. */
export function strictFlags() {
  return plugin({
    id: 'varlock:strict-flags',
    name: 'strict-flags',
    setup(ctx) {
      ctx.decorateCommand((baseRunner) => (cmdCtx) => {
        assertNoUnknownFlags(cmdCtx);
        return baseRunner(cmdCtx);
      });
    },
  });
}
