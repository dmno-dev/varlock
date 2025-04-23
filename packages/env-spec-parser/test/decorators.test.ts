import { describe, it, expect } from 'vitest';
import {
  ParsedEnvSpecFunctionArgs, ParsedEnvSpecFunctionCall, ParsedEnvSpecStaticValue, parseEnvSpecDotEnvFile,
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
        try {
          const result = parseEnvSpecDotEnvFile(fullInputString);
          // find first config item, flatten decorators into object, check against expected
          const configItem = result.configItems[0];
          const decoratorObject = configItem.decoratorsObject;
          for (const key in expectedDecorators) {
            const expectedValue = expectedDecorators[key];
            if (typeof expectedValue === 'object' && 'fnName' in expectedValue) {
              // if we passed a function name, expecting a function call with a fn name and args
              if (expectedValue.fnName) {
                expectInstanceOf(decoratorObject[key].value, ParsedEnvSpecFunctionCall);
                expect(decoratorObject[key].value.name).toEqual(expectedValue.fnName);
                expect(decoratorObject[key].value.simplifiedArgs).toEqual(expectedValue.fnArgs);

              // if we passed undefined, we are expecting a bare function call - ex; `@import(some/path)`
              } else {
                expect(decoratorObject[key].bareFnArgs?.simplifiedValues).toEqual(expectedValue.fnArgs);
              }
            } else {
              expectInstanceOf(decoratorObject[key].value, ParsedEnvSpecStaticValue);
              expect(decoratorObject[key].value.value).toEqual(expectedValue);
            }
          }
        } catch (error) {
          // check if we expected an error
          if (!(expectedDecorators instanceof Error)) throw error;
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
    // bar fn calls - ex: `@import(some/path)`
    ['# @enableFoo()', { enableFoo: { fnName: undefined, fnArgs: [] } }],
    ['# @enableFoo(bar)', { enableFoo: { fnName: undefined, fnArgs: ['bar'] } }],
    ['# @import(../some/path)', { import: { fnName: undefined, fnArgs: ['../some/path'] } }],
  ]));

  describe('whitespace handling', basicDecoratorTests([
    ['#@dec=1', { dec: 1 }],
    ['#\t@dec=1', { dec: 1 }],
    ['#   @dec=1', { dec: 1 }],
  ]));

  describe('errors', basicDecoratorTests([
    ['# @dec=', new Error()],
    ['# @dec=', new Error()],
    ['# @dec="', new Error()],
    ['# @dec="""', new Error()],
    ['# @dec="foo" not commented', new Error()],
    ['# @dec1@dec2', new Error()],
    ['# @dec1()', new Error()],
    ['# @', new Error()],
    ['# @0badDecorator', new Error()],
    ['# @bad-decorator', new Error()],
  ]));

  describe('comments and line breaks', basicDecoratorTests([
    {
      label: 'mixed with comments ',
      comments: [
        '# comment before',
        '# @dec1',
        '# comment after',
        '#@dec2',
      ].join('\n'),
      expected: { dec1: true, dec2: true },
    },
    {
      label: 'multiple decorators on one line',
      comments: '# @bool  @email="me@example.com" \t @num=123 ',
      expected: { bool: true, email: 'me@example.com', num: 123 },
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
      expected: { dec: true },
    },
  ]));
});
