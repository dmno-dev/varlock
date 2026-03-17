/*
  Test our resolvers functions

  Note that @env-spec/parser tests the mechanics of the parsing
  so here we mostly just need to test the translation from parser to resolvers
  and that the resolvers are working as expected
*/


import { describe, it, expect } from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';
import { ResolutionError, SchemaError } from '../lib/errors';
import { Resolver } from '../lib/resolver';
import type { Constructor } from '@env-spec/utils/type-utils';

// define special increment resolver used only for tests
class IncrementResolver extends Resolver {
  static def = {
    name: 'increment',
    label: 'increment',
    icon: '',
    resolve() { return ''; },
  };
  static counter = 0;
  async resolve() { return ++IncrementResolver.counter; }
}

function functionValueTests(
  tests: Record<string, {
    input: string;
    expected: Record<string, string | number | boolean | undefined | Constructor<Error>>;
    /** if true, expects items to have only warnings (not full errors) while still resolving */
    expectWarnings?: boolean;
  }>,
) {
  return () => {
    Object.entries(tests).forEach(([label, spec]) => {
      const { input, expected, expectWarnings } = spec;
      it(label, async () => {
        const g = new EnvGraph();


        // reset the increment counter for each test
        IncrementResolver.counter = 0;
        g.registerResolver(IncrementResolver);

        const testDataSource = new DotEnvFileDataSource('.env.schema', {
          overrideContents: outdent`
            # @defaultRequired=false
            # ---
            ${input}
          `,
        });
        await g.setRootDataSource(testDataSource);
        await g.finishLoad();

        await g.resolveEnvValues();
        for (const key in expected) {
          const item = g.configSchema[key];
          const expectedValue = expected[key];
          if (expectedValue === SchemaError) {
            expect(item.errors.length).toBeGreaterThan(0);
            expect(item.errors[0]).toBeInstanceOf(SchemaError);
          } else if (expectedValue === ResolutionError) {
            expect(item.resolutionError).toBeInstanceOf(ResolutionError);
          } else {
            if (expectWarnings) {
              // item should have warnings only (not hard errors), and still resolve
              expect(item.validationState, `Expected item ${key} to have warnings, not errors`).not.toBe('error');
            } else {
              expect(item.isValid, `Expected item ${key} to be valid`).toBeTruthy();
            }
            expect(item.resolvedValue).toEqual(expectedValue);
          }
        }
      });
    });
  };
}


describe('concat()', functionValueTests({
  'working example': {
    input: 'ITEM=concat("a", "", b, undefined, `c`)',
    expected: { ITEM: 'abc' },
  },
  'error - no args': {
    input: 'ITEM=concat()',
    expected: { ITEM: SchemaError },
  },
  'error - single arg': {
    input: 'ITEM=concat(a)',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=concat(a=b, c=d)',
    expected: { ITEM: SchemaError },
  },
}));

describe('fallback()', functionValueTests({
  'working example': {
    input: 'ITEM=fallback("", undefined, first, second)',
    expected: { ITEM: 'first' },
  },
  'error - no args': {
    input: 'ITEM=fallback()',
    expected: { ITEM: SchemaError },
  },
  'error - single arg': {
    input: 'ITEM=fallback(a)',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=fallback(a=b, c=d)',
    expected: { ITEM: SchemaError },
  },
  'triggers error if invalid arg is evaluated': {
    input: 'ITEM=fallback(ref(BADKEY), "foo")',
    expected: { ITEM: SchemaError },
  },
  // ! we may want to change this in the future
  // and instead allow a resolver to attempt to resolve until it hits an invalid child
  'still triggers error if invalid arg will not actually be evaluated': {
    input: 'ITEM=fallback("foo", ref(BADKEY))',
    expected: { ITEM: SchemaError },
  },
}));

describe('exec()', functionValueTests({
  'working example': {
    input: 'ITEM=exec("echo moo")',
    expected: { ITEM: 'moo' },
  },
  'error - no command': {
    input: 'ITEM=exec()',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=exec(cmd="echo moo")',
    expected: { ITEM: SchemaError },
  },
}));


describe('ref()', functionValueTests({
  'working example': {
    input: outdent`
      OTHER=otherval
      ITEM=ref(OTHER)
    `,
    expected: { ITEM: 'otherval' },
  },
  'working example with $ expansion': {
    input: outdent`
      A=a-val
      B=$A
    `,
    expected: { A: 'a-val', B: 'a-val' },
  },
  // this applies to all dependencies, not just `ref()`
  'dependent items are allowed to be defined out of order': {
    input: outdent`
      B=$A
      A=a-val
    `,
    expected: { A: 'a-val', B: 'a-val' },
  },

  // this increment resolver is used in the next test
  // it just increments a global counter each time it is resolved
  'check increment() resolver is working properly': {
    input: 'ITEM=concat(increment(), increment(), increment())',
    expected: { ITEM: '123' },
  },
  'multiple dependencies dont trigger multiple resolutions': {
    input: outdent`
      A=a
      B=b
      C=c
      ITEM=concat("$A$B$C", increment())
    `,
    expected: { ITEM: 'abc1' }, // would be 'abc3' if it resolved for each dependency
  },
  'error - no key': {
    input: 'ITEM=ref()',
    expected: { ITEM: SchemaError },
  },
  'error - not string key': {
    input: 'ITEM=ref(123)',
    expected: { ITEM: SchemaError },
  },
  'error - not-existant key': {
    input: outdent`
      OTHER=otherval
      ITEM=ref(BADKEY)
    `,
    expected: { ITEM: SchemaError },
  },
  'error - non-static key': {
    input: outdent`
      OTHER=otherval
      REFKEY=OTHER
      ITEM=ref(ref(REFKEY))
    `,
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: outdent`
      OTHER=otherval
      ITEM=ref(key=OTHER)
    `,
    expected: { ITEM: SchemaError },
  },
}));

describe('regex()', functionValueTests({
  'error - regex used as value': {
    input: 'ITEM=regex(.*)',
    expected: { ITEM: ResolutionError },
  },
  'error - invalid regex': {
    input: outdent`
      OTHER=other
      ITEM=remap($OTHER, regex("("), bad, foo, default)
    `,
    expected: { ITEM: SchemaError },
  },
  'error - invalid regex (legacy syntax)': {
    input: outdent`
      OTHER=other
      ITEM=remap($OTHER, bad=regex("("), default)
    `,
    expected: { ITEM: SchemaError },
  },
  // functionality is checked below within remap() tests
}));

describe('remap()', functionValueTests({
  'keeps original value if no match found': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, b, a, c, b)
    `,
    expected: { ITEM: 'foo' },
  },
  'remaps exact match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, buz, biz, foo, bar)
    `,
    expected: { ITEM: 'bar' },
  },
  'remaps regex match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, buz, biz, regex(fo+), bar)
    `,
    expected: { ITEM: 'bar' },
  },
  'remaps undefined match': {
    input: outdent`
      REMAP_ME=
      ITEM=remap($REMAP_ME, buz, biz, undefined, bar)
    `,
    expected: { REMAP_ME: undefined, ITEM: 'bar' },
  },
  'uses default when no match': {
    input: outdent`
      REMAP_ME=unknown
      ITEM=remap($REMAP_ME, foo, a, bar, b, default-val)
    `,
    expected: { ITEM: 'default-val' },
  },
  // legacy key=value syntax (deprecated but still supported - emits a deprecation warning)
  'legacy key=val: keeps original value if no match found': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, a=b, b=c)
    `,
    expected: { ITEM: 'foo' },
    expectWarnings: true,
  },
  'legacy key=val: remaps exact match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, biz=buz, bar=foo)
    `,
    expected: { ITEM: 'bar' },
    expectWarnings: true,
  },
  'legacy key=val: remaps regex match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, biz=buz, bar=regex(fo+))
    `,
    expected: { ITEM: 'bar' },
    expectWarnings: true,
  },
  'legacy key=val: remaps undefined match': {
    input: outdent`
      REMAP_ME=
      ITEM=remap($REMAP_ME, biz=buz, bar=undefined)
    `,
    expected: { REMAP_ME: undefined, ITEM: 'bar' },
    expectWarnings: true,
  },
  'error - no args': {
    input: 'ITEM=remap()',
    expected: { ITEM: SchemaError },
  },
  'error - too few args': {
    input: 'ITEM=remap("value")',
    expected: { ITEM: SchemaError },
  },
  'error - too few args (2 positional)': {
    input: 'ITEM=remap("value", "match")',
    expected: { ITEM: SchemaError },
  },
}));

describe('eq()', functionValueTests({
  'check equality': {
    input: outdent`
      STR=eq("a", "a")
      NUM=eq(42, 42)
      BOOL=eq(false, false)
      UNDEF=eq(undefined, undefined)
    `,
    expected: {
      STR: true,
      NUM: true,
      BOOL: true,
      UNDEF: true,
    },
  },
  'check inequality': {
    input: outdent`
      STR=eq("a", "b")
      NUM=eq(42, 41)
      BOOL=eq(true, false)
      MIXED=eq(42, "42")
    `,
    expected: {
      STR: false,
      NUM: false,
      BOOL: false,
      MIXED: false,
    },
  },
  'with variables': {
    input: outdent`
      A=test
      B=test
      C=different
      ITEM1=eq($A, $B)
      ITEM2=eq($A, $C)
    `,
    expected: { ITEM1: true, ITEM2: false },
  },
  'with nested resolvers': {
    input: 'ITEM=eq(concat("a", "b"), "ab")',
    expected: { ITEM: true },
  },
  'working example - undefined values': {
    input: outdent`
      A=
      B=
      ITEM=eq($A, $B)
    `,
    expected: { A: undefined, B: undefined, ITEM: true },
  },
  'error - no args': {
    input: 'ITEM=eq()',
    expected: { ITEM: SchemaError },
  },
  'error - single arg': {
    input: 'ITEM=eq("a")',
    expected: { ITEM: SchemaError },
  },
  'error - too many args': {
    input: 'ITEM=eq("a", "b", "c")',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=eq(left="a", right="b")',
    expected: { ITEM: SchemaError },
  },
}));

describe('if()', functionValueTests({
  'working examples': {
    input: outdent`
      TRUE=if(true, yes, no)
      FALSE=if(false, yes, no)
      STR=if("a", yes, no)
      NUM=if(1, yes, no)
      NUM0=if(0, yes, no)
    `,
    expected: {
      TRUE: 'yes',
      FALSE: 'no',
      STR: 'yes',
      NUM: 'yes',
      NUM0: 'no',
    },
  },
  'with nested fns': {
    input: outdent`
      ITEM1=if(eq(a, a), if(true, yes), no)
      ITEM2=if(eq(a, b), yes, if(true, no))
    `,
    expected: {
      ITEM1: 'yes',
      ITEM2: 'no',
    },
  },
  'no true/false values will coerce to boolean': {
    input: outdent`
      T1=if(hello)
      T2=if(true)
      T3=if(123)
      F1=if(undefined)
      F2=if("")
      F3=if(false)
      F4=if(0)
    `,
    expected: {
      T1: true, T2: true, T3: true, F1: false, F2: false, F3: false, F4: false,
    },
  },
  'optional false value will use undefined': {
    input: outdent`
      ITEM1=if(true, "yes")
      ITEM2=if(false, "yes")
    `,
    expected: { ITEM1: 'yes', ITEM2: undefined },
  },
  'error - no args': {
    input: 'ITEM=if()',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=if(condition=true, trueVal="yes", falseVal="no")',
    expected: { ITEM: SchemaError },
  },
  'error - nested bad arg': {
    input: 'ITEM=if(ref(BADKEY), "yes", "no")',
    expected: { ITEM: SchemaError },
  },
}));

describe('ifs()', functionValueTests({
  'returns value for first truthy condition': {
    input: outdent`
      ITEM=ifs(false, first, true, second, third)
    `,
    expected: { ITEM: 'second' },
  },
  'returns default when no condition matches': {
    input: outdent`
      ITEM=ifs(false, first, false, second, default-val)
    `,
    expected: { ITEM: 'default-val' },
  },
  'returns undefined when no match and no default': {
    input: outdent`
      ITEM=ifs(false, first, false, second)
    `,
    expected: { ITEM: undefined },
  },
  'with nested eq() conditions': {
    input: outdent`
      ENV=dev
      ITEM=ifs(eq($ENV, prod), prod-url, eq($ENV, staging), staging-url, dev-url)
    `,
    expected: { ITEM: 'dev-url' },
  },
  'with eq() matching first condition': {
    input: outdent`
      ENV=prod
      ITEM=ifs(eq($ENV, prod), prod-url, eq($ENV, staging), staging-url, dev-url)
    `,
    expected: { ITEM: 'prod-url' },
  },
  'single condition as default': {
    input: outdent`
      ITEM=ifs(eq("a", "b"), first, eq("b", "c"), second, default-val)
    `,
    expected: { ITEM: 'default-val' },
  },
  'error - no args': {
    input: 'ITEM=ifs()',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=ifs(condition=true, val="yes")',
    expected: { ITEM: SchemaError },
  },
}));

describe('not()', functionValueTests({
  'working - falsy values': {
    input: outdent`
      FALSE=not(false)
      EMPTY_STR=not("")
      ZERO=not(0)
      UNDEF=not(undefined)
    `,
    expected: {
      FALSE: true,
      EMPTY_STR: true,
      ZERO: true,
      UNDEF: true,
    },
  },
  'with truthy values': {
    input: outdent`
      STR=not("hello")
      NUM=not(42)
      BOOL=not(true)
    `,
    expected: {
      STR: false,
      NUM: false,
      BOOL: false,
    },
  },
  'with nested resolvers': {
    input: outdent`
      ITEM1=not(eq("a", "a"))
      ITEM2=not(eq("a", "b"))
    `,
    expected: { ITEM1: false, ITEM2: true },
  },
  'error - no args': {
    input: 'ITEM=not()',
    expected: { ITEM: SchemaError },
  },
  'error - too many args': {
    input: 'ITEM=not(true, false)',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=not(value=true)',
    expected: { ITEM: SchemaError },
  },
  'error - nested bad arg': {
    input: 'ITEM=not(ref(BADKEY))',
    expected: { ITEM: SchemaError },
  },
}));

describe('isEmpty()', functionValueTests({
  working: {
    input: outdent`
      UNDEF=isEmpty(undefined)
      EMPTY_STR=isEmpty("")
      STR=isEmpty(foo)
      ZERO=isEmpty(0)
      NUM=isEmpty(1)
      FALSE=isEmpty(false)
    `,
    expected: {
      UNDEF: true,
      EMPTY_STR: true,
      STR: false,
      ZERO: false,
      NUM: false,
      FALSE: false,
    },
  },
  'with nested resolvers': {
    input: outdent`
      ITEM1=isEmpty(concat("", ""))
      ITEM2=isEmpty(concat("a", "b"))
      ITEM3=isEmpty(if(true, undefined))
    `,
    expected: { ITEM1: true, ITEM2: false, ITEM3: true },
  },
  'error - no args': {
    input: 'ITEM=isEmpty()',
    expected: { ITEM: SchemaError },
  },
  'error - too many args': {
    input: 'ITEM=isEmpty("", "test")',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=isEmpty(value="")',
    expected: { ITEM: SchemaError },
  },
  'error - nested bad arg': {
    input: 'ITEM=isEmpty(ref(BADKEY))',
    expected: { ITEM: SchemaError },
  },
}));

// --------

describe('dependency cycles', functionValueTests({
  'detect cycle - self': {
    input: 'A=$A',
    expected: { A: SchemaError },
  },
  'detect cycle - self within nested fn': {
    input: 'A="foo-$A-bar"',
    expected: { A: SchemaError },
  },
  'detect cycle - pair': {
    input: outdent`
      A=$B
      B=$A
    `,
    expected: { A: SchemaError, B: SchemaError },
  },
  'detect cycle - >2 items': {
    input: outdent`
      A=$B
      B=$C
      C=$A
    `,
    expected: { A: SchemaError, B: SchemaError, C: SchemaError },
  },
}));

describe('unknown resolver', functionValueTests({
  'unknown resolver fn': {
    input: 'ITEM=bad()',
    expected: { ITEM: SchemaError },
  },
  'unknown resolver fn nested': {
    input: 'ITEM=concat(a, bad(), c)',
    expected: { ITEM: SchemaError },
  },
}));

describe('resolveItemWithDeps()', () => {
  it('resolves a single item and its transitive dependencies', async () => {
    IncrementResolver.counter = 0;
    const g = new EnvGraph();
    g.registerResolver(IncrementResolver);
    const testDataSource = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        A=a-val
        B=$A
        C=c-val
        UNREACHABLE=concat(increment(), increment())
      `,
    });
    await g.setRootDataSource(testDataSource);
    await g.finishLoad();

    // Only resolve B (and its dependency A), not C or UNREACHABLE
    await g.resolveItemWithDeps('B');

    expect(g.configSchema.A.resolvedValue).toEqual('a-val');
    expect(g.configSchema.B.resolvedValue).toEqual('a-val');
    // C and UNREACHABLE should not have been resolved
    expect(g.configSchema.C.resolvedValue).toBeUndefined();
    // increment() should not have been called (counter stays at 0)
    expect(IncrementResolver.counter).toEqual(0);
  });
});
