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

// define special increment resolver used only for tests
class IncrementResolver extends Resolver {
  static fnName = 'increment';
  label = 'increment';
  icon = '';
  static counter = 0;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async _process() {}
  async _resolve() { return ++IncrementResolver.counter; }
}

function functionValueTests(
  tests: Record<string, {
    input: string;
    env?: Record<string, string>;
    expected: Record<string, any> | Error
  }>,
) {
  return () => {
    Object.entries(tests).forEach(([label, spec]) => {
      const { input, expected } = spec;
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
        g.addDataSource(testDataSource);
        await testDataSource.finishInit();
        await g.finishLoad();

        if (expected instanceof Error) {
          expect(g.dataSources[0].loadingError).toBeTruthy();
        } else {
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
              expect(item.isValid, `Expected item ${key} to be valid`).toBeTruthy();
              expect(item.resolvedValue).toEqual(expectedValue);
            }
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
    input: 'OTHER=otherval\nITEM=ref(OTHER)',
    expected: { ITEM: 'otherval' },
  },
  'working example with $ expansion': {
    input: 'A=a-val\nB=$A',
    expected: { A: 'a-val', B: 'a-val' },
  },
  // this applies to all dependencies, not just `ref()`
  'dependent items are allowed to be defined out of order': {
    input: 'B=$A\nA=a-val',
    expected: { A: 'a-val', B: 'a-val' },
  },

  // this increment resolver is used in the next test
  // it just increments a global counter each time it is resolved
  'check increment() resolver is working properly': {
    input: 'ITEM=concat(increment(), increment(), increment())',
    expected: { ITEM: '123' },
  },
  'multiple dependencies dont trigger multiple resolutions': {
    input: 'A=a\nB=b\nC=c\nITEM=concat("$A$B$C", increment())',
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
    input: 'OTHER=otherval\nITEM=ref(BADKEY)',
    expected: { ITEM: SchemaError },
  },
  'error - non-static key': {
    input: 'OTHER=otherval\nREFKEY=OTHER\nITEM=ref(ref(REFKEY))',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'OTHER=otherval\nITEM=ref(key=OTHER)',
    expected: { ITEM: SchemaError },
  },
}));

describe('regex()', functionValueTests({
  'error - regex used as value': {
    input: 'ITEM=regex(.*)',
    expected: { ITEM: ResolutionError },
  },
}));

describe('remap()', functionValueTests({
  'keeps original value if no match found': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, a=b, b=c)
    `,
    expected: { ITEM: 'foo' },
  },
  'remaps exact match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, biz=buz, bar=foo)
    `,
    expected: { ITEM: 'bar' },
  },
  'remaps regex match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, biz=buz, bar=regex(fo+))
    `,
    expected: { ITEM: 'bar' },
  },
  'remaps undefined match': {
    input: outdent`
      REMAP_ME=
      ITEM=remap($REMAP_ME, biz=buz, bar=undefined)
    `,
    expected: { REMAP_ME: undefined, ITEM: 'bar' },
  },
  'error - no args': {
    input: 'ITEM=remap()',
    expected: { ITEM: SchemaError },
  },
  'error - no value': {
    input: 'ITEM=remap(key=val)',
    expected: { ITEM: SchemaError },
  },
  'error - extra arg': {
    input: 'ITEM=remap("value", key=val, "extra")',
    expected: { ITEM: SchemaError },
  },
}));


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
    input: 'A=$B\nB=$A',
    expected: { A: SchemaError, B: SchemaError },
  },
  'detect cycle - >2 items': {
    input: 'A=$B\nB=$C\nC=$A',
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
