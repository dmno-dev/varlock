/* eslint-disable no-template-curly-in-string */
import { describe, it, expect } from 'vitest';
import { parseEnvSpecDotEnvFile } from '../src';
import { simpleResolver } from '../src/simple-resolver';

function functionValueTests(
  tests: Record<string, {
    input: string;
    env?: Record<string, string>;
    expected: Record<string, any> | Error
  }>,
) {
  return () => {
    Object.entries(tests).forEach(([label, spec]) => {
      const { input, env, expected } = spec;
      it(label, () => {
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
      });
    });
  };
}

describe('function calls', functionValueTests({
  // basic tests that are functions and test resolver is working properly
  'concat()': {
    input: 'ITEM=concat("a", "b", "c")',
    expected: { ITEM: 'abc' },
  },
  'fallback()': {
    input: 'ITEM=fallback("", undefined, "default-val")',
    expected: { ITEM: 'default-val' },
  },
  'eval()': {
    input: 'ITEM=eval("echo moo")',
    // we'll fetch whoami from the system
    expected: { ITEM: 'moo' },
  },
  'ref()': {
    input: 'FOO=foo-val\nITEM=ref("FOO")',
    expected: {
      FOO: 'foo-val',
      ITEM: 'foo-val',
    },
  },
  'nested function calls': {
    input: 'OTHERVAL=d\nITEM=concat("a", fallback("", "b"), eval("echo c"), ref(OTHERVAL))',
    expected: { ITEM: 'abcd' },
  },
}));


describe('eval expansion', functionValueTests({
  'eval expansion - unquoted': {
    input: 'ITEM=$(echo foo)',
    expected: { ITEM: 'foo' },
  },
  'eval expansion within quotes - double quotes': {
    input: 'ITEM="$(echo foo)"',
    expected: { ITEM: 'foo' },
  },
  'eval expansion within quotes - backticks': {
    input: 'ITEM=`$(echo foo)`',
    expected: { ITEM: 'foo' },
  },
  'eval expansion within quotes - single quotes (NOT EXPANDED)': {
    input: "ITEM='$(echo foo)'",
    expected: { ITEM: '$(echo foo)' },
  },
  'eval expansion with quotes inside': {
    input: 'ITEM=$(echo "foo bar")',
    expected: { ITEM: 'foo bar' },
  },
}));

describe('ref expansion', functionValueTests({
  'ref expansion - unquoted': {
    input: 'OTHER=foo\nITEM=${OTHER}',
    expected: { ITEM: 'foo' },
  },
  'ref expansion within quotes - double quotes': {
    input: 'OTHER=foo\nITEM="${OTHER}"',
    expected: { ITEM: 'foo' },
  },
  'ref expansion within quotes - backtick': {
    input: 'OTHER=foo\nITEM=`${OTHER}`',
    expected: { ITEM: 'foo' },
  },
  'ref expansion within quotes - single quotes (NOT EXPANDED)': {
    input: "OTHER=foo\nITEM='${OTHER}'",
    expected: { ITEM: '${OTHER}' },
  },
  'ref expansion - simple (no brackets)': {
    input: 'OTHER=foo\nITEM=$OTHER',
    expected: { ITEM: 'foo' },
  },
  'ref expansion - with brackets': {
    input: 'FOO=foo\nITEM=${FOO}',
    expected: { ITEM: 'foo' },
  },
}));

describe('complex cases', functionValueTests({
  'multiple expansions': {
    input: 'FOO=foo\nBAR=bar\nITEM=${FOO}-$BAR-$(echo baz)',
    expected: { ITEM: 'foo-bar-baz' },
  },
  'multiple expansions w/ pre+post strings': {
    input: 'FOO=foo\nBAR=bar\nITEM=pre-${FOO}-$BAR-$(echo baz)-post',
    expected: { ITEM: 'pre-foo-bar-baz-post' },
  },
}));
