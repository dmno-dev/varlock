/*
  Test our resolvers functions

  Note that @env-spec/parser tests the mechanics of the parsing
  so here we mostly just need to test the translation from parser to resolvers
  and that the resolvers are working as expected
*/


import { describe, it, expect } from 'vitest';
import { DotEnvFileDataSource, EnvGraph } from '../src';
import { SchemaError } from '../src/lib/errors';

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
      it(label, async () => {
        const g = new EnvGraph();
        const testDataSource = new DotEnvFileDataSource('.env.schema', { overrideContents: input });
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
              expect(item.resolverSchemaErrors.length).toBeGreaterThan(0);
            } else {
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
  'no args': {
    input: 'ITEM=concat()',
    expected: { ITEM: SchemaError },
  },
  'single arg': {
    input: 'ITEM=concat(a)',
    expected: { ITEM: SchemaError },
  },
  'key/val args': {
    input: 'ITEM=concat(a=b, c=d)',
    expected: { ITEM: SchemaError },
  },
}));

describe('fallback()', functionValueTests({
  'working example': {
    input: 'ITEM=fallback("", undefined, first, second)',
    expected: { ITEM: 'first' },
  },
  'no args': {
    input: 'ITEM=fallback()',
    expected: { ITEM: SchemaError },
  },
  'single arg': {
    input: 'ITEM=fallback(a)',
    expected: { ITEM: SchemaError },
  },
  'key/val args': {
    input: 'ITEM=fallback(a=b, c=d)',
    expected: { ITEM: SchemaError },
  },
}));

describe('eval()', functionValueTests({
  'working example': {
    input: 'ITEM=eval("echo moo")',
    expected: { ITEM: 'moo' },
  },
  'no command': {
    input: 'ITEM=eval()',
    expected: { ITEM: SchemaError },
  },
  'key/val args': {
    input: 'ITEM=eval(cmd="echo moo")',
    expected: { ITEM: SchemaError },
  },
}));

describe('ref()', functionValueTests({
  'working example': {
    input: 'OTHER=otherval\nITEM=ref(OTHER)',
    expected: { ITEM: 'otherval' },
  },
  'no key': {
    input: 'ITEM=ref()',
    expected: { ITEM: SchemaError },
  },
  'not string key': {
    input: 'ITEM=ref(123)',
    expected: { ITEM: SchemaError },
  },
  'not-existant key': {
    input: 'OTHER=otherval\nITEM=ref(BADKEY)',
    expected: { ITEM: SchemaError },
  },
  'non-static key': {
    input: 'OTHER=otherval\nREFKEY=OTHER\nITEM=ref(ref(REFKEY))',
    expected: { ITEM: SchemaError },
  },
  'key/val args': {
    input: 'OTHER=otherval\nITEM=ref(key=OTHER)',
    expected: { ITEM: SchemaError },
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
