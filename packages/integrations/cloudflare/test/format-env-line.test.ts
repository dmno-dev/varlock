import {
  describe, it, expect,
} from 'vitest';
import { parse as parseDotenv } from 'dotenv';
import { formatEnvLine, quoteForDotenv } from '../src/format-env-line';

/** Round-trip through dotenv parse, matching Wrangler's `.dev.vars` reader. */
function roundTrip(value: string): string {
  const line = formatEnvLine('KEY', value);
  const parsed = parseDotenv(line);
  return parsed.KEY ?? '';
}

describe('quoteForDotenv / formatEnvLine', () => {
  it('prefers single quotes when the value has no apostrophe', () => {
    expect(quoteForDotenv('hello')).toBe("'hello'");
    expect(quoteForDotenv('say "hi"')).toBe("'say \"hi\"'");
    expect(quoteForDotenv('path\\to\\file')).toBe("'path\\to\\file'");
    expect(quoteForDotenv('line1\nline2')).toBe("'line1\nline2'");
  });

  it('falls back to backticks when the value contains an apostrophe', () => {
    expect(quoteForDotenv("it's")).toBe("`it's`");
    expect(quoteForDotenv('it\'s"secret\\path')).toBe('`it\'s"secret\\path`');
  });

  it('falls back to double quotes when single and backtick are present but safe', () => {
    expect(quoteForDotenv('a`b\'c')).toBe('"a`b\'c"');
  });

  it('throws when every quote style would corrupt the value', () => {
    expect(() => quoteForDotenv('all\'"`quotes')).toThrow(/Unable to serialize/);
    expect(() => quoteForDotenv('a`b\'c\\d')).toThrow(/Unable to serialize/);
    expect(() => quoteForDotenv('a`b\'c\nd')).toThrow(/Unable to serialize/);
  });

  it('round-trips mixed punctuation that previously corrupted via escaped quotes', () => {
    const values = [
      'simple',
      'has space',
      "it's",
      'say "hi"',
      'path\\to\\file',
      'it\'s"secret\\path',
      'line1\nline2',
      'a`b',
      // eslint-disable-next-line no-template-curly-in-string -- intentional dotenv-like value
      '${EXPAND}',
      '#hash',
      '{"k":"v"}',
      'mix\'and"quotes',
    ];
    for (const value of values) {
      expect(roundTrip(value), value).toBe(value);
    }
  });

  it('formats KEY=quoted-value lines', () => {
    expect(formatEnvLine('SECRET', 'it\'s"secret\\path')).toBe('SECRET=`it\'s"secret\\path`');
  });
});
