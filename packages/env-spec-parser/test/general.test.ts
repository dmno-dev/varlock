
import { it, expect } from 'vitest';
import { parseEnvSpecDotEnvFile, ParsedEnvSpecBlankLine, ParsedEnvSpecConfigItem } from '../src';
import { simpleResolver } from '../src/simple-resolver';

function generalTest(spec: {
  input: string;
  env?: Record<string, string>;
  expected: Record<string, any> | Error
}) {
  return () => {
    const { input, env, expected } = spec;

    if (expected instanceof Error) {
      // TODO: should prob split between parse error vs resolve error?
      expect(() => parseEnvSpecDotEnvFile(input)).toThrow();
    } else {
      const parsedFile = parseEnvSpecDotEnvFile(input);
      const resolved = simpleResolver(parsedFile, { env: env ?? {} });
      for (const key in expected) {
        expect(resolved[key]).toEqual(expected[key]);
      }
    }
  };
}

it('supports \\r\\n style newlines', generalTest({
  input: 'FOO=foo\r\nBAR=bar\r\n',
  expected: {
    FOO: 'foo',
    BAR: 'bar',
  },
}));

it('treats whitespace-only lines as blank lines', generalTest({
  // line with only spaces/tabs between items must not break parsing
  input: 'FOO=foo\n   \nBAR=bar\n\t \nBAZ=baz\n',
  expected: {
    FOO: 'foo',
    BAR: 'bar',
    BAZ: 'baz',
  },
}));

it('parses a whitespace-only line into a ParsedEnvSpecBlankLine', () => {
  const parsed = parseEnvSpecDotEnvFile('FOO=foo\n  \t \nBAR=bar\n');
  const [first, second, third] = parsed.contents;
  expect(first).toBeInstanceOf(ParsedEnvSpecConfigItem);
  expect(second).toBeInstanceOf(ParsedEnvSpecBlankLine);
  expect(third).toBeInstanceOf(ParsedEnvSpecConfigItem);
});

it('handles a trailing whitespace-only line with no final newline', generalTest({
  // last line is whitespace-only and the file does not end in a newline
  input: 'FOO=foo\nBAR=bar\n   ',
  expected: {
    FOO: 'foo',
    BAR: 'bar',
  },
}));

it('parses a trailing whitespace-only line (no newline) into a ParsedEnvSpecBlankLine', () => {
  const parsed = parseEnvSpecDotEnvFile('FOO=foo\n  \t');
  const [first, second] = parsed.contents;
  expect(first).toBeInstanceOf(ParsedEnvSpecConfigItem);
  expect(second).toBeInstanceOf(ParsedEnvSpecBlankLine);
});

it('handles consecutive, leading, and CRLF whitespace-only lines', generalTest({
  input: '  \n\t\nFOO=foo\n   \n  \nBAR=bar\r\n \r\nBAZ=baz\n',
  expected: {
    FOO: 'foo',
    BAR: 'bar',
    BAZ: 'baz',
  },
}));

it('allows a whitespace-only line directly after a comment line', generalTest({
  // the comment-line terminator must tolerate the trailing whitespace blank line
  input: '# a comment\n   \nFOO=foo\n',
  expected: {
    FOO: 'foo',
  },
}));

it('allows a whitespace-only line directly after a decorator comment', () => {
  // a whitespace blank line detaches the decorator just like a plain blank line does
  const parsed = parseEnvSpecDotEnvFile('# @required\n   \nFOO=foo\n');
  const last = parsed.contents[parsed.contents.length - 1];
  expect(last).toBeInstanceOf(ParsedEnvSpecConfigItem);
});
