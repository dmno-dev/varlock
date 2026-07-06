import { describe, it, expect } from 'vitest';
import type { ArgToken, Args } from 'gunshi/plugin';

import {
  findUnknownFlags, suggestFlag, assertNoUnknownFlags, levenshtein,
} from './strict-flags-plugin';
import { CliExitError } from './helpers/exit-error';

// mirrors the shape of a real command arg schema (kebab-case names, shorts, negatable)
const ARGS: Args = {
  'redact-stdout': { type: 'boolean', negatable: true },
  inject: { type: 'string', short: 'i' },
  path: { type: 'string', short: 'p' },
  'clear-cache': { type: 'boolean' },
  'allow-reload': { type: 'boolean' },
};

function option(name: string, index = 0): ArgToken {
  return {
    kind: 'option', index, name, rawName: name.length === 1 ? `-${name}` : `--${name}`,
  };
}
function positional(value: string, index = 0): ArgToken {
  return { kind: 'positional', index, value };
}
const terminator: ArgToken = { kind: 'option-terminator', index: 99 };

describe('findUnknownFlags', () => {
  it('flags an unknown/misspelled option', () => {
    expect(findUnknownFlags([option('alow-reload')], ARGS)).toEqual(['--alow-reload']);
  });

  it('accepts a correctly spelled long flag', () => {
    expect(findUnknownFlags([option('clear-cache')], ARGS)).toEqual([]);
  });

  it('accepts a declared short alias', () => {
    expect(findUnknownFlags([option('p'), option('i')], ARGS)).toEqual([]);
  });

  it('accepts --no-<name> for a negatable flag', () => {
    expect(findUnknownFlags([option('no-redact-stdout')], ARGS)).toEqual([]);
  });

  it('always allows --help/-h and --version/-v', () => {
    expect(findUnknownFlags(
      [option('help'), option('h'), option('version'), option('v')],
      ARGS,
    )).toEqual([]);
  });

  it('ignores everything after the -- terminator (child passthrough)', () => {
    const tokens: Array<ArgToken> = [
      option('clear-cache', 0),
      terminator,
      positional('node', 1),
      // even if a later option-looking token slips through, it must not be rejected
      {
        kind: 'option', index: 2, name: 'experimental-foo', rawName: '--experimental-foo',
      },
    ];
    expect(findUnknownFlags(tokens, ARGS)).toEqual([]);
  });

  it('collects multiple unknown flags', () => {
    expect(findUnknownFlags([option('alow-reload'), option('totally-bogus')], ARGS))
      .toEqual(['--alow-reload', '--totally-bogus']);
  });
});

describe('suggestFlag', () => {
  it('suggests the closest declared flag within edit distance 2', () => {
    expect(suggestFlag('--alow-reload', ARGS)).toBe('--allow-reload');
  });

  it('returns undefined when nothing is close', () => {
    expect(suggestFlag('--totally-bogus', ARGS)).toBeUndefined();
  });
});

describe('levenshtein', () => {
  it('computes small edit distances', () => {
    expect(levenshtein('alow-reload', 'allow-reload')).toBe(1);
    expect(levenshtein('same', 'same')).toBe(0);
  });
});

describe('assertNoUnknownFlags', () => {
  it('throws a CliExitError for an unknown flag', () => {
    expect(() => assertNoUnknownFlags({ name: 'proxy', tokens: [option('alow-reload')], args: ARGS }))
      .toThrow(CliExitError);
    try {
      assertNoUnknownFlags({ name: 'proxy', tokens: [option('alow-reload')], args: ARGS });
    } catch (err) {
      expect((err as CliExitError).message).toContain('Unknown flag: --alow-reload');
      expect((err as CliExitError).getFormattedOutput()).toContain('Did you mean');
    }
  });

  it('does not throw for known flags', () => {
    expect(() => assertNoUnknownFlags({ name: 'run', tokens: [option('clear-cache')], args: ARGS }))
      .not.toThrow();
  });

  it('skips the internal `complete` command', () => {
    expect(() => assertNoUnknownFlags({ name: 'complete', tokens: [option('anything')], args: {} }))
      .not.toThrow();
  });
});
