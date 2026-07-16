/* eslint-disable no-template-curly-in-string */
import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { parseEnvSpecDotEnvFile } from '../src';
import {
  ParsedEnvSpecFunctionCall, ParsedEnvSpecArrayLiteral, ParsedEnvSpecObjectLiteral,
} from '../src/classes';
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
    input: 'ITEM=remap("foo", aaa, zzz, fallback("", "foo"), bar)',
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
  'multi-line with positional args': {
    input: outdent`
      ITEM=remap(
        "baz",
        baz, bar,
        qux, foo
      )
    `,
    expected: { ITEM: 'bar' },
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
  'multi-line with a commented-out arg and trailing post-comments': {
    input: outdent`
      ITEM=concat(
        "a", # first part
        # "b" is disabled,
        "c",
      )
    `,
    expected: { ITEM: 'ac' },
  },
  'commented-out arg via double hash': {
    input: outdent`
      ITEM=concat(
        "x",
        ## "y",
        "z"
      )
    `,
    expected: { ITEM: 'xz' },
  },
}));

// Object/array literals inside item values use plain-newline continuation (NOT `#`),
// and `#` introduces a comment to end-of-line. These assert the parsed AST directly
// since the test resolver has no built-in function that consumes a literal.
describe('object/array literals in item values (multi-line + comments)', () => {
  function literalArg(input: string) {
    const file = parseEnvSpecDotEnvFile(input);
    const fn = file.configItems[0].value as ParsedEnvSpecFunctionCall;
    expect(fn).toBeInstanceOf(ParsedEnvSpecFunctionCall);
    return fn.data.args.values[0];
  }

  it('array literal: skips a commented-out entry and a trailing post-comment', () => {
    const arg = literalArg(outdent`
      ITEM=fn([
        ALPHA,
        # BETA disabled,
        GAMMA, # primary
      ])
    `);
    expect(arg).toBeInstanceOf(ParsedEnvSpecArrayLiteral);
    expect((arg as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual(['ALPHA', 'GAMMA']);
  });

  it('object literal: skips a commented-out entry and a trailing post-comment', () => {
    const arg = literalArg(outdent`
      ITEM=fn({
        count=3, # retries
        # backoff=2,
        timeout=30,
      })
    `);
    expect(arg).toBeInstanceOf(ParsedEnvSpecObjectLiteral);
    expect((arg as ParsedEnvSpecObjectLiteral).simplifiedValue).toEqual({ count: 3, timeout: 30 });
  });

  it('comment-only and blank interior lines do not break the array', () => {
    const arg = literalArg(outdent`
      ITEM=fn([
        ONE,
        # just a comment
        TWO,
      ])
    `);
    expect((arg as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual(['ONE', 'TWO']);
  });

  it('nested literal inside a multi-line literal, with comments', () => {
    const arg = literalArg(outdent`
      ITEM=fn({
        items=[
          1,
          # 2 disabled,
          3,
        ], # the list
      })
    `);
    expect((arg as ParsedEnvSpecObjectLiteral).simplifiedValue).toEqual({ items: [1, 3] });
  });
});

describe('object/array literal edge cases (item-value context)', () => {
  function firstArg(input: string) {
    const file = parseEnvSpecDotEnvFile(input);
    const fn = file.configItems[0].value as ParsedEnvSpecFunctionCall;
    expect(fn).toBeInstanceOf(ParsedEnvSpecFunctionCall);
    return fn.data.args.values[0];
  }

  it('coerces numbers/bools/undefined inside literals', () => {
    const arg = firstArg('ITEM=fn([1, 2.5, true, undefined])');
    expect((arg as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual([1, 2.5, true, undefined]);
  });

  it('nested single-line object in a keyword arg', () => {
    const file = parseEnvSpecDotEnvFile('ITEM=fn(retry={count=3, backoff=[1, 2]})');
    const fn = file.configItems[0].value as ParsedEnvSpecFunctionCall;
    const kv = fn.data.args.values[0] as any;
    expect(kv.key).toBe('retry');
    expect((kv.value as ParsedEnvSpecObjectLiteral).simplifiedValue).toEqual({ count: 3, backoff: [1, 2] });
  });

  it('a glued `#` stays part of a literal element', () => {
    const arg = firstArg('ITEM=fn([a#b, c])');
    expect((arg as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual(['a#b', 'c']);
  });

  it('whitespace-only interior lines do not break a multi-line literal', () => {
    const arg = firstArg('ITEM=fn([\n  a,\n   \n  b,\n])');
    expect((arg as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual(['a', 'b']);
  });
});
