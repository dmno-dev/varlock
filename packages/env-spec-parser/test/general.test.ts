
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

// --- multi-line string interior whitespace ---
// The whitespace-only-blank-line rules above operate only at file scope. A
// multi-line string greedily consumes all of its interior content into its
// value, so blank lines, whitespace-only lines, and trailing whitespace inside
// a multi-line string must be preserved verbatim and never treated as blanks.

it('preserves a blank line inside a triple-double-quoted multi-line string', generalTest({
  input: 'FOO="""\nline1\n\nline2\n"""\nBAR=bar\n',
  expected: {
    FOO: '\nline1\n\nline2\n',
    BAR: 'bar',
  },
}));

it('preserves a whitespace-only line inside a triple-double-quoted multi-line string', generalTest({
  input: 'FOO="""\nline1\n   \nline2\n"""\n',
  expected: {
    FOO: '\nline1\n   \nline2\n',
  },
}));

it('preserves a whitespace-only line inside a triple-backtick multi-line string', generalTest({
  input: 'FOO=```\nline1\n\t \nline2\n```\n',
  expected: {
    FOO: '\nline1\n\t \nline2\n',
  },
}));

it('preserves a whitespace-only line inside a single-double-quoted multi-line string', generalTest({
  input: 'FOO="line1\n  \nline2"\n',
  expected: {
    FOO: 'line1\n  \nline2',
  },
}));

it('preserves trailing whitespace on lines inside a multi-line string', () => {
  // assert on the raw value so the trailing-whitespace bytes are checked exactly
  const parsed = parseEnvSpecDotEnvFile('FOO="""\nline1   \nline2\t\n"""\n');
  const [item] = parsed.contents;
  expect(item).toBeInstanceOf(ParsedEnvSpecConfigItem);
  expect((item as ParsedEnvSpecConfigItem).value?.data?.rawValue)
    .toBe('"""\nline1   \nline2\t\n"""');
});

it('excludes commented-out config items from item descriptions', () => {
  const parsedFile = parseEnvSpecDotEnvFile([
    '# real description',
    '# ITEM=secret-prod-value',
    '#ITEM2=no-space',
    '# export ITEM3 = with-export',
    '## ITEM4=double-commented',
    '# # ITEM5=spaced-double-commented',
    '#  #   # ITEM6=many-hashes',
    '# ITEM7 = spaced-equals',
    '# mentions ITEM=value mid-line',
    'ITEM=dev-value',
  ].join('\n'));
  const item = parsedFile.configItems[0] as ParsedEnvSpecConfigItem;
  expect(item.description).toEqual('real description\nmentions ITEM=value mid-line');
  expect(item.description).not.toContain('secret-prod-value');
  // still round-trips the original file untouched
  expect(item.toString()).toContain('# ITEM=secret-prod-value');
});

it('excludes continuation lines of commented-out multi-line values from descriptions', () => {
  const cases: Array<[string, Array<string>]> = [
    ['triple double quotes', ['# VAL="""', '#   secret', '#   more secret', '# """']],
    ['triple backticks', ['# VAL=```', '# secret', '# ```']],
    ['multi-line double quotes', ['# VAL="secret', '# more secret"']],
    ['multi-line single quotes', ["# VAL='secret", "# more secret'"]],
    ['object literal', ['# VAL={', '#   key=secret,', '# }']],
    ['array literal', ['# VAL=[', '#   secret,', '# ]']],
    ['function call', ['# VAL=fn(', '#   "secret",', '#   key={ a=secret },', '# )']],
    ['nested double comment', ['# # VAL="""', '# # secret', '# # """']],
  ];
  for (const [label, valueLines] of cases) {
    const parsedFile = parseEnvSpecDotEnvFile([
      '# before',
      ...valueLines,
      '# after',
      'VAL=foo',
    ].join('\n'));
    const item = parsedFile.configItems[0] as ParsedEnvSpecConfigItem;
    expect(item.description, label).toEqual('before\nafter');
  }
});

it('does not treat quotes inside unquoted commented-out values as multi-line', () => {
  const parsedFile = parseEnvSpecDotEnvFile([
    "# NAME=it's",
    '# real description',
    'NAME=foo',
  ].join('\n'));
  const item = parsedFile.configItems[0] as ParsedEnvSpecConfigItem;
  expect(item.description).toEqual('real description');
});
