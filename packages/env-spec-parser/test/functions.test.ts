/* eslint-disable no-template-curly-in-string */
import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
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
    input: outdent`
      FOO=foo-val
      ITEM=ref("FOO")
    `,
    expected: {
      FOO: 'foo-val',
      ITEM: 'foo-val',
    },
  },
  'nested function calls - array': {
    input: outdent`
      OTHERVAL=d
      ITEM=concat("a", fallback("", "b"), exec("echo c"), ref(OTHERVAL))
    `,
    expected: { ITEM: 'abcd' },
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
    input: outdent`
      OTHER=foo
      ITEM=\${OTHER}
    `,
    expected: { ITEM: 'foo' },
  },
  'ref expansion within quotes - double quotes': {
    input: outdent`
      OTHER=foo
      ITEM="\${OTHER}"
    `,
    expected: { ITEM: 'foo' },
  },
  'ref expansion within quotes - backtick': {
    input: outdent`
      OTHER=foo
      ITEM=\`\${OTHER}\`
    `,
    expected: { ITEM: 'foo' },
  },
  'ref expansion within quotes - single quotes (NOT EXPANDED)': {
    input: outdent`
      OTHER=foo
      ITEM='\${OTHER}'
    `,
    expected: { ITEM: '${OTHER}' },
  },
  'ref expansion - simple (no brackets)': {
    input: outdent`
      OTHER=foo
      ITEM=$OTHER
    `,
    expected: { ITEM: 'foo' },
  },
  'ref expansion - with brackets': {
    input: outdent`
      FOO=foo
      ITEM=\${FOO}
    `,
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
    input: outdent`
      FOO=foo
      ITEM=\${FOO:-defaultfoo}
    `,
    expected: { ITEM: 'foo' },
  },
}));

describe('complex cases', functionValueTests({
  'multiple expansions': {
    input: outdent`
      FOO=foo
      BAR=bar
      ITEM=\${FOO}-$BAR-$(echo baz)-\${UNDEF:-qux}
    `,
    expected: { ITEM: 'foo-bar-baz-qux' },
  },
  'multiple expansions w/ pre+post strings': {
    input: outdent`
      FOO=foo
      BAR=bar
      ITEM=pre-\${FOO}-$BAR-$(echo baz)-post
    `,
    expected: { ITEM: 'pre-foo-bar-baz-post' },
  },
  'expansion nested in function': {
    input: outdent`
      OTHERVAL=other
      ITEM=fallback("", "\${OTHERVAL}")
    `,
    expected: { ITEM: 'other' },
  },
}));

describe('multi-line function calls in values', functionValueTests({
  'basic multi-line concat': {
    input: outdent`
      ITEM=concat(
        "a",
        "b",
        "c"
      )
    `,
    expected: { ITEM: 'abc' },
  },
  'multi-line with nested function': {
    input: outdent`
      ITEM=concat(
        "prefix-",
        fallback("", "f1"),
        fallback(
          "",
          "f2"
        ),
        "-suffix"
      )
    `,
    expected: { ITEM: 'prefix-f1f2-suffix' },
  },
  'multi-line with varying indentation': {
    input: outdent`
      ITEM=concat(
      "a",
          "b",
        "c"
      )
    `,
    expected: { ITEM: 'abc' },
  },
  'multi-line with key=value args': {
    input: outdent`
      ITEM=remap(
        "baz",
        bar=baz,
        foo=qux
      )
    `,
    expected: { ITEM: 'bar' }, // remap returns KEY whose VALUE matches
  },
  'multi-line empty': {
    input: outdent`
      ITEM=concat(
      )
    `,
    expected: { ITEM: '' },
  },
  'value after multi-line function': {
    input: outdent`
      ITEM1=concat(
        "a",
        "b"
      )
      ITEM2=simple
    `,
    expected: { ITEM1: 'ab', ITEM2: 'simple' },
  },
}));
