import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import {
  ParsedEnvSpecFunctionCall, ParsedEnvSpecFunctionArgs, ParsedEnvSpecStaticValue, parseEnvSpecDotEnvFile,
} from '../src';
import { expectInstanceOf } from './test-utils';

function basicDecoratorTests(tests: Array<[string, any] | { label: string, comments: string, expected: any }>) {
  return () => {
    tests.forEach((spec) => {
      const [commentsInput, expectedDecorators] = Array.isArray(spec) ? spec : [spec.comments, spec.expected];
      const fullInputString = `${commentsInput}\nVAL=`;
      let expectedOutputString = `${JSON.stringify(expectedDecorators)}`;
      if (expectedDecorators instanceof Error) {
        expectedOutputString = '🚨 _PARSE ERROR_';
      }

      let testName = `check \`${commentsInput}\` -> ${expectedOutputString}`;
      if ('label' in spec) testName = spec.label;

      it(testName, () => {
        if (expectedDecorators instanceof Error) {
          expect(() => parseEnvSpecDotEnvFile(fullInputString)).toThrow();
        } else {
          const result = parseEnvSpecDotEnvFile(fullInputString);
          // find first config item, flatten decorators into object, check against expected
          const configItem = result.configItems[0];
          const decoratorObject = configItem.decoratorsObject;

          if (Object.keys(expectedDecorators).length === 0) {
            expect(Object.keys(decoratorObject).length).toBe(0);
          }

          for (const key in expectedDecorators) {
            if (key.startsWith('!')) {
              expect(decoratorObject).not.toHaveProperty(key);
              continue;
            }

            const expectedValue = expectedDecorators[key];
            if (typeof expectedValue === 'object' && 'fnName' in expectedValue) {
              // if we passed a function name, expecting a function call with a fn name and args
              if (expectedValue.fnName) {
                expectInstanceOf(decoratorObject[key].value, ParsedEnvSpecFunctionCall);
                expect(decoratorObject[key].value.name).toEqual(expectedValue.fnName);
                expect(decoratorObject[key].value.simplifiedArgs).toEqual(expectedValue.fnArgs);

              // if we passed undefined, we are expecting a bare function call - ex; `@import(some/path)`
              } else {
                expect(decoratorObject[key].isBareFnCall).toBe(true);
                expectInstanceOf(decoratorObject[key].value, ParsedEnvSpecFunctionArgs);
                expect(decoratorObject[key].value?.simplifiedValues).toEqual(expectedValue.fnArgs);
              }
            } else {
              expectInstanceOf(decoratorObject[key].value, ParsedEnvSpecStaticValue);
              expect(decoratorObject[key].value.value).toEqual(expectedValue);
            }
          }
        }
      });
    });
  };
}


describe('decorator parsing', () => {
  describe('static value parsing', basicDecoratorTests([
    ['# @dec', { dec: true }],
    ['# @dec=true', { dec: true }],
    ['# @dec=undefined', { dec: undefined }],
    ['# @dec=foo', { dec: 'foo' }],
    ['# @dec=foo#bar', { dec: 'foo' }],
    ['# @dec=null', { dec: 'null' }], // null not treated specially
    ['# @dec=123', { dec: 123 }],
    ['# @dec=123.456', { dec: 123.456 }],
    ['# @dec=123.456.789', { dec: '123.456.789' }],
    ['# @dec=123e10', { dec: '123e10' }],
    ['# @dec="foo"', { dec: 'foo' }],
    ['# @dec="@#\\"()"', { dec: '@#"()' }],
    ['# @dec=@bar@', { dec: '@bar@' }],
  ]));

  describe('function call parsing', basicDecoratorTests([
    // array args
    ['# @dec=decFn()', { dec: { fnName: 'decFn', fnArgs: [] } }],
    ['# @dec=decFn(arrArg)', { dec: { fnName: 'decFn', fnArgs: ['arrArg'] } }],
    ['# @dec=decFn(arrArg1, "arrArg2")', { dec: { fnName: 'decFn', fnArgs: ['arrArg1', 'arrArg2'] } }],
    // obj args
    ['# @dec=decFn(k1=v1)', { dec: { fnName: 'decFn', fnArgs: { k1: 'v1' } } }],
    ['# @dec=decFn(k1=v1, k2="v2")', { dec: { fnName: 'decFn', fnArgs: { k1: 'v1', k2: 'v2' } } }],
    // bare fn calls - ex: `@import(some/path)`
    ['# @enableFoo()', { enableFoo: { fnName: undefined, fnArgs: [] } }],
    ['# @enableFoo(bar)', { enableFoo: { fnName: undefined, fnArgs: ['bar'] } }],
    ['# @import(../some/path)', { import: { fnName: undefined, fnArgs: ['../some/path'] } }],
  ]));

  describe('multi-line function calls', basicDecoratorTests([
    {
      label: 'multi-line @dec() call',
      comments: outdent`
        # @import(
        #   ./.env.import,
        #   ITEM1,
        #   ITEM2,
        # )
      `,
      expected: { import: { fnName: undefined, fnArgs: ['./.env.import', 'ITEM1', 'ITEM2'] } },
    },
    {
      label: 'multi-line @dec=fn()',
      comments: outdent`
        # @dec=someFn(
        #   arg1,
        #   arg2
        # )
      `,
      expected: { dec: { fnName: 'someFn', fnArgs: ['arg1', 'arg2'] } },
    },
    {
      label: 'multi-line with key=value args',
      comments: outdent`
        # @config(
        #   key1=val1,
        #   key2="val2"
        # )
      `,
      expected: { config: { fnName: undefined, fnArgs: { key1: 'val1', key2: 'val2' } } },
    },
    {
      label: 'multi-line with varying indentation',
      comments: outdent`
        # @import(
        #ITEM1,
        #  ITEM2,
        #    ITEM3
        #)
      `,
      expected: { import: { fnName: undefined, fnArgs: ['ITEM1', 'ITEM2', 'ITEM3'] } },
    },
    {
      label: 'multi-line decorator followed by another decorator on same closing line',
      comments: outdent`
        # @import(
        #   ITEM1
        # ) @required
      `,
      expected: {
        import: { fnName: undefined, fnArgs: ['ITEM1'] },
        required: true,
      },
    },
    {
      label: 'empty multi-line fn call',
      comments: outdent`
        # @doSomething(
        # )
      `,
      expected: { doSomething: { fnName: undefined, fnArgs: [] } },
    },
    {
      label: 'bad multi-line dec fn call (missing #)',
      comments: outdent`
        # @import(
        ./.env.import,
        #   ITEM1,
        #   ITEM2,
        # )
      `,
      expected: new Error(),
    },
    {
      label: 'multi-line dec fn with commented interior line',
      comments: outdent`
        # @import(
        #   ./.env.import,
        # #  ITEM1,
        #   ITEM2,
        # )
      `,
      expected: new Error(),
    },
  ]));

  describe('whitespace handling', basicDecoratorTests([
    ['#@dec=1', { dec: 1 }],
    ['#\t@dec=1', { dec: 1 }],
    ['#   @dec=1', { dec: 1 }],
  ]));

  describe('errors / weird cases', basicDecoratorTests([
    ['# @dec=', new Error()],
    ['# @dec="', new Error()],
    ['# @dec="foo', new Error()],
    ['# @dec="`"', { dec: '`' }],
    ['# @dec="\\""', { dec: '"' }],
    ['# @dec=qu"ote', { dec: 'qu"ote' }],
    ['# @dec=foo bar', new Error()],
    ['# @dec="""', new Error()],
    ['# @dec="foo" not commented', new Error()],
    ['# @dec1@dec2', new Error()],
    ['# @', new Error()],
    ['# @0badDecorator', new Error()],
    ['# @bad-decorator', new Error()],
    ['# @okDec @badDecWithColon:', new Error()],

    // want to gracefully handle these, since we've seen them in the wild
    // so instead of dying, we'll just treat them as normal comments
    ['# @see https://example.com for info', { '!see': true }],
    ['# @see @something https://example.com for info', new Error()],
    ['# @todo:', { '!todo': true, '!todo:': true }],
    ['# @todo: fix me later', { '!todo': true, '!todo:': true }],
  ]));

  describe('comments and line breaks', basicDecoratorTests([
    {
      label: 'mixed with comments ',
      comments: outdent`
        # comment before
        # @dec1
        # comment after
        #@dec2
      `,
      expected: { dec1: true, dec2: true },
    },
    {
      label: 'multiple decorators on one line',
      comments: '# @bool  @email="me@example.com" \t @num=123 ',
      expected: { bool: true, email: 'me@example.com', num: 123 },
    },
    {
      label: 'multiple decorators on one line',
      comments: '# @foo=bar @bool',
      expected: { foo: 'bar', bool: true },
    },
    {
      label: 'multiple decorators on multiple lines',
      comments: '# @dec1 @dec2=123\n# @dec3',
      expected: { dec1: true, dec2: 123, dec3: true },
    },
    {
      label: 'decorators within text comments ignored',
      comments: '# will be @ignored\n# @dec',
      expected: { dec: true },
    },
    {
      label: 'extra blank line will detach comment from config item',
      comments: '# @dec\n',
      expected: {},
    },
    {
      label: 'divider will detach comment from config item',
      comments: '# @dec\n# ---',
      expected: {},
    },
    {
      label: 'extra post comments allowed after decorators',
      comments: '# @dec # more comments',
      expected: { dec: true },
    },
    {
      label: 'post comments are not parsed for decorators',
      comments: '# @dec # @ignored',
      expected: { dec: true, '!ignored': true },
    },
  ]));
});
