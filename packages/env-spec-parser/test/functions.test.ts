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
  // basic tests that our functions parsing and test resolver is working properly
  'concat() - no args': {
    input: 'ITEM=concat()',
    expected: { ITEM: '' },
  },
  'concat() - single arg': {
    input: 'ITEM=concat("a")',
    expected: { ITEM: 'a' },
  },
  'concat() - multiple args': {
    input: 'ITEM=concat("a", "b", "c")',
    expected: { ITEM: 'abc' },
  },
  'fallback()': {
    input: 'ITEM=fallback("", undefined, "default-val")',
    expected: { ITEM: 'default-val' },
  },
  'exec()': {
    input: 'ITEM=exec("echo moo")',
    expected: { ITEM: 'moo' },
  },
  'ref()': {
    input: 'FOO=foo-val\nITEM=ref("FOO")',
    expected: {
      FOO: 'foo-val',
      ITEM: 'foo-val',
    },
  },
  'replace()': {
    input: 'ITEM=replace("foo", "f", "b")',
    expected: { ITEM: 'boo' },
  },
  'nested function calls - array': {
    input: 'OTHERVAL=d\nITEM=concat("a", fallback("", "b"), exec("echo c"), ref(OTHERVAL))',
    expected: { ITEM: 'abcd' },
  },
  'nested function calls - replace()': {
    input: 'FOO=foo-val\nITEM=replace(ref("FOO"), "f", "b")',
    expected: {
      FOO: 'foo-val',
      ITEM: 'boo-val',
    },
  },
  'nested function calls - key/value': {
    input: 'ITEM=remap("foo", zzz=aaa, bar=fallback("", "foo"))',
    expected: { ITEM: 'bar' },
  },
}));


describe('exec expansion', functionValueTests({
  'exec expansion - unquoted': {
    input: 'ITEM=$(echo foo)',
    expected: { ITEM: 'foo' },
  },
  'exec expansion within quotes - double quotes': {
    input: 'ITEM="$(echo foo)"',
    expected: { ITEM: 'foo' },
  },
  'exec expansion within quotes - backticks': {
    input: 'ITEM=`$(echo foo)`',
    expected: { ITEM: 'foo' },
  },
  'exec expansion within quotes - single quotes (NOT EXPANDED)': {
    input: "ITEM='$(echo foo)'",
    expected: { ITEM: '$(echo foo)' },
  },
  'exec expansion with quotes inside': {
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
  'ref fallback - ":-" separator': {
    input: 'ITEM=${FOO:-defaultfoo}',
    expected: { ITEM: 'defaultfoo' },
  },
  'ref fallback - "-" separator': {
    input: 'ITEM=${FOO-defaultfoo}',
    expected: { ITEM: 'defaultfoo' },
  },
  'ref fallback - ":" in default value': {
    input: 'ITEM=${FOO:-default:-foo}',
    expected: { ITEM: 'default:-foo' },
  },
  'ref defaults - default not used': {
    input: 'FOO=foo\nITEM=${FOO:-defaultfoo}',
    expected: { ITEM: 'foo' },
  },
}));

describe('replace expansion', functionValueTests({
  'ref expansion - unquoted': {
    input: 'OTHER=foo\nITEM=replace($OTHER, "f", "b")',
    expected: {
      OTHER: 'foo',
      ITEM: 'boo',
    },
  },
  'ref expansion within quotes - double quotes': {
    input: 'OTHER=foo\nITEM="${replace($OTHER, "f", "b")}"',
    expected: {
      OTHER: 'foo',
      ITEM: 'boo',
    },
  },
  'ref expansion within quotes - backtick': {
    input: 'OTHER=foo\nITEM=`${replace($OTHER, "f", "b")}`',
    expected: {
      OTHER: 'foo',
      ITEM: 'boo',
    },
  },
  'ref expansion within quotes - single quotes (NOT EXPANDED)': {
    input: "OTHER=foo\nITEM='${replace($OTHER, 'f', 'b')}'",
    expected: {
      OTHER: 'foo',
      ITEM: '${replace($OTHER, "f", "b")}',
    },
  },
  'ref expansion - simple (no brackets)': {
    input: 'OTHER=foo\nITEM=replace($OTHER, "f", "b")',
    expected: {
      OTHER: 'foo',
      ITEM: 'boo',
    },
  },
  'ref expansion - with brackets': {
    input: 'FOO=foo\nITEM=replace($FOO, "f", "b")',
    expected: {
      FOO: 'foo',
      ITEM: 'boo',
    },
  },
}));

describe('complex cases', functionValueTests({
  'multiple expansions': {
    input: 'FOO=foo\nBAR=bar\nITEM=${FOO}-$BAR-$(echo baz)-${UNDEF:-qux}',
    expected: { ITEM: 'foo-bar-baz-qux' },
  },
  'multiple expansions w/ pre+post strings': {
    input: 'FOO=foo\nBAR=bar\nITEM=pre-${FOO}-$BAR-$(echo baz)-post',
    expected: { ITEM: 'pre-foo-bar-baz-post' },
  },
  'expansion nested in function': {
    input: 'OTHERVAL=other\nITEM=fallback("", "${OTHERVAL}")',
    expected: { ITEM: 'other' },
  },
}));
