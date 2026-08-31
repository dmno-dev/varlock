import { describe, it, expect } from 'vitest';
import {
  levenshtein,
  suggestClosest,
  commandPathFromArgs,
  isArgError,
  toCliExitError,
} from '../arg-errors';

/** Shape of gunshi's unknown-option error (matched structurally, never by instanceof) */
const unknownOption = (rawName: string, candidates: Array<string>) => ({
  code: 'err:arg:unknown-option',
  values: { rawName, name: rawName.replace(/^--?/, ''), candidates },
});

/** Stand-in for gunshi's CommandNotFoundError, which reaches us from its own bundle */
class CommandNotFoundError extends Error {
  commandName: string;
  candidates: Array<string>;
  commandPath: Array<string>;
  constructor(commandName: string, candidates: Array<string>, commandPath: Array<string> = []) {
    super(`Command not found: ${commandName}`);
    this.name = 'CommandNotFoundError';
    this.commandName = commandName;
    this.candidates = candidates;
    this.commandPath = commandPath;
  }
}

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('alow-reload', 'allow-reload')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
});

describe('suggestClosest', () => {
  it('finds a near match regardless of dashes', () => {
    expect(suggestClosest('--alow-reload', ['--path', '--allow-reload'])).toBe('--allow-reload');
    expect(suggestClosest('lod', ['load', 'run'])).toBe('load');
  });

  it('returns undefined when nothing is close enough', () => {
    expect(suggestClosest('--wildly-different', ['--path', '--format'])).toBeUndefined();
    expect(suggestClosest('--anything', [])).toBeUndefined();
  });

  it('prefers the closest candidate', () => {
    expect(suggestClosest('--pat', ['--path', '--paths'])).toBe('--path');
  });
});

describe('commandPathFromArgs', () => {
  it('takes leading non-flag tokens only', () => {
    expect(commandPathFromArgs(['proxy', 'start', '--alow-reload'])).toEqual(['proxy', 'start']);
    expect(commandPathFromArgs(['load'])).toEqual(['load']);
    expect(commandPathFromArgs(['--bogus'])).toEqual([]);
  });

  it('stops at the passthrough terminator', () => {
    expect(commandPathFromArgs(['run', '--', 'next', 'dev'])).toEqual(['run']);
  });
});

describe('isArgError', () => {
  it('only matches an AggregateError', () => {
    expect(isArgError(new AggregateError([]))).toBe(true);
    expect(isArgError(new Error('boom'))).toBe(false);
    expect(isArgError(undefined)).toBe(false);
  });
});

describe('toCliExitError', () => {
  it('formats an unknown flag with a suggestion and a help pointer', () => {
    const error = new AggregateError([unknownOption('--alow-reload', ['--path', '--allow-reload'])]);
    const out = toCliExitError(error, ['proxy', 'start', '--alow-reload']).getFormattedOutput();

    expect(out).toContain('Unknown flag: --alow-reload');
    expect(out).toContain('Did you mean');
    expect(out).toContain('--allow-reload');
    expect(out).toContain('varlock proxy start --help');
  });

  it('pluralizes and lists every unknown flag', () => {
    const error = new AggregateError([
      unknownOption('--one', []),
      unknownOption('--two', []),
    ]);
    const out = toCliExitError(error, ['load']).getFormattedOutput();
    expect(out).toContain('Unknown flags: --one, --two');
  });

  it('omits the suggestion when nothing is close enough', () => {
    const error = new AggregateError([unknownOption('--totally-unrelated', ['--path'])]);
    const out = toCliExitError(error, ['load']).getFormattedOutput();
    expect(out).toContain('Unknown flag: --totally-unrelated');
    expect(out).not.toContain('Did you mean');
  });

  it('formats an unknown subcommand with a suggestion', () => {
    const error = new AggregateError([new CommandNotFoundError('lod', ['load', 'run'])]);
    const out = toCliExitError(error, ['lod']).getFormattedOutput();

    expect(out).toContain('Invalid subcommand: lod');
    expect(out).toContain('Did you mean');
    expect(out).toContain('varlock load');
  });

  it('suggests a nested subcommand under its parent path, so the advice is runnable', () => {
    // `varlock proxy strat` must not suggest `varlock start`, which does not exist
    const error = new AggregateError([new CommandNotFoundError('strat', ['start', 'run'], ['proxy'])]);
    const out = toCliExitError(error, ['proxy', 'strat']).getFormattedOutput();

    expect(out).toContain('Invalid subcommand: strat');
    expect(out).toContain('varlock proxy start');
    expect(out).not.toMatch(/Did you mean\s+\S*varlock start/);
    // and point at the help for the level that actually failed
    expect(out).toContain('varlock proxy --help');
  });

  it('never suggests the anonymous entry command', () => {
    const error = new AggregateError([new CommandNotFoundError('anonymou', ['(anonymous)', 'load'])]);
    const out = toCliExitError(error, ['anonymou']).getFormattedOutput();
    expect(out).not.toContain('(anonymous)');
  });

  it('passes through other validation errors (bad enum, wrong type)', () => {
    const error = new AggregateError([new Error("Optional argument '--format' should be chosen from 'enum' [\"json\"] values")]);
    const out = toCliExitError(error, ['load', '--format']).getFormattedOutput();

    expect(out).toContain('Invalid arguments');
    expect(out).toContain("Optional argument '--format'");
    expect(out).toContain('varlock load --help');
  });
});
