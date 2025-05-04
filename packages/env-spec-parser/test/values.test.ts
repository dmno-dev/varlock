import { describe, it, expect } from 'vitest';
import ansis from 'ansis';
import { ParsedEnvSpecFunctionCall, ParsedEnvSpecStaticValue, parseEnvSpecDotEnvFile } from '../src';
import { expectInstanceOf } from './test-utils';


function basicValueTests(tests: Array<[string, any]>) {
  return () => {
    tests.forEach(([input, expectedValue]) => {
      const inputString = `VAL=${input}`;
      const inputLabel = inputString.replaceAll('\n', ansis.gray('↩'));
      let outputLabel = expectedValue;
      outputLabel = JSON.stringify(outputLabel)?.replaceAll('\\n', ansis.gray('↩'));
      if (typeof expectedValue !== 'string') outputLabel += ` [${typeof expectedValue}]`;

      if (typeof expectedValue === 'object' && 'fnName' in expectedValue) {
        outputLabel = `FUNCTION: ${expectedValue.fnName}(${JSON.stringify(expectedValue.fnArgs)})`;
      } else if (expectedValue instanceof Error) {
        outputLabel = '🚨 _PARSE ERROR_';
      }

      it(`${inputLabel} -> ${outputLabel}`, () => {
        if (expectedValue instanceof Error) {
          expect(() => parseEnvSpecDotEnvFile(inputString)).toThrow();
        } else {
          const result = parseEnvSpecDotEnvFile(inputString);
          const valNode = result.configItems[0].value;
          if (typeof expectedValue === 'object' && 'fnName' in expectedValue) {
            expectInstanceOf(valNode, ParsedEnvSpecFunctionCall);
            expect(valNode.name).toEqual(expectedValue.fnName);
            expect(valNode.simplifiedArgs).toEqual(expectedValue.fnArgs);
          } else {
            expectInstanceOf(valNode, ParsedEnvSpecStaticValue);
            expect(valNode.value).toEqual(expectedValue);
          }
        }
      });
    });
  };
}

describe('value parsing', () => {
  describe('strings and quotes', basicValueTests([
    ['', undefined],
    ['undefined', undefined],
    ['""', ''],
    ['unquoted', 'unquoted'],
    ['inner"\'`quotes', 'inner"\'`quotes'],
    ["'squote'", 'squote'],
    ['"dquote"', 'dquote'],
    ['`backtick`', 'backtick'],
    ['"this has spaces"', 'this has spaces'],
    ['"mixed`quote"', 'mixed`quote'],
    ['"escaped\\"quote"', 'escaped"quote'],
    ['unquoted spaces', 'unquoted spaces'],
    ['  extra-spaces  ', 'extra-spaces'],
    ["'not'escaped'", new Error()],

    ['"not ok', new Error()],
    [' "not ok', new Error()],
  ]));

  describe('multi-line strings', basicValueTests([
    ['"this\nhas\nmultiple\nlines"', 'this\nhas\nmultiple\nlines'],
    ['"with\\"escaped\nquotes"', 'with"escaped\nquotes'],
    ['"with #comments\ninside" # and after', 'with #comments\ninside'],
    ['"""triple quotes\nalso work"""', 'triple quotes\nalso work'],
    ['"""\n  hello\n"""', '\n  hello\n'],
    ['```triple backticks\nalso work```', 'triple backticks\nalso work'],
    ['```check `internal` quotes \\```\nare ok```', 'check `internal` quotes ```\nare ok'],
    ['"""triple quotes on one line are not ok"""', new Error()],
    ['"""no end', new Error()],
    ['"""no end\nagain', new Error()],
  ]));

  describe('boolean handling', basicValueTests([
    ['true', true],
    ['false', false],
    ['"true"', 'true'],
    ['"false"', 'false'],
  ]));


  describe('number handling', basicValueTests([
    ['0', 0],
    ['123', 123],
    ['123.456', 123.456],
    ['.0', 0],
    ['.01230', 0.0123],
    ['123.456.789', '123.456.789'],
    ['10e3', '10e3'],
    ['001', '001'],
    ['123.', '123.'],
    ['123..', '123..'],
  ]));

  describe('function calls', basicValueTests([
    ['foo()', { fnName: 'foo', fnArgs: [] }],
    ['"foo()"', 'foo()'],
    ['bad-fn-name()', 'bad-fn-name()'],
    ['0badFn()', '0badFn()'],
    ['foo(123)', { fnName: 'foo', fnArgs: [123] }],
    ['foo(1,2,3)', { fnName: 'foo', fnArgs: [1, 2, 3] }],
    ['foo(123 , "bar"  , true)', { fnName: 'foo', fnArgs: [123, 'bar', true] }],
    ['foo(key1=foo, key2=bar)', { fnName: 'foo', fnArgs: { key1: 'foo', key2: 'bar' } }],
    ['foo(key1=123, key2="\\")#")', { fnName: 'foo', fnArgs: { key1: 123, key2: '")#' } }],
  ]));

  describe('post-comment handling', basicValueTests([
    ['#comment', undefined],
    [' #comment', undefined],
    ['#', undefined],
    ['foo#comment', 'foo'],
    ['"foo" #comment', 'foo'],
    ['"foo#comment"#more', 'foo#comment'],
    ['123#comment', 123],
    ['123 #comment', 123],
    ['123 # @dec', 123],
  ]));
});
