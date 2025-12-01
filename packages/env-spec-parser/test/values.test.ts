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
            // no value set (e.g. `ITEM=`) has no value node at all
            if (valNode) {
              expectInstanceOf(valNode, ParsedEnvSpecStaticValue);
              expect(valNode.value).toEqual(expectedValue);
            } else {
              if (expectedValue !== undefined) {
                throw new Error(`Expected value ${expectedValue} but got implicit undefined`);
              }
            }
          }
        }
      });
    });
  };
}


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
  ['-123', -123],
  ['123.456', 123.456],
  ['-123.456', -123.456],
  ['0.0123', 0.0123],
  // if the number is not converted cleanly back to a string, we leave as a string
  ['.0', '.0'],
  ['.01230', '.01230'],
  ['1.230', '1.230'],
  // number-ish but not quite numbers
  ['123.456.789', '123.456.789'],
  ['10e3', '10e3'],
  ['001', '001'],
  ['01', '01'],
  ['123.', '123.'],
  ['123..', '123..'],
  ['Infinity', 'Infinity'],
  // numbers that would lose precision are treated as strings
  ['92183090832018209318123781721.12231', '92183090832018209318123781721.12231'],
  ['1.23123412341234123414352345234523452345234523452345234523452345234523452345', '1.23123412341234123414352345234523452345234523452345234523452345234523452345'],
  // max safe integer is still a number
  [(Number.MAX_SAFE_INTEGER).toString(), Number.MAX_SAFE_INTEGER],
  // but anything larger is treated as a string
  [(Number.MAX_SAFE_INTEGER + 1).toString(), (Number.MAX_SAFE_INTEGER + 1).toString()],
]));

describe('function calls', basicValueTests([
  ['foo()', { fnName: 'foo', fnArgs: [] }],
  ['foo( )', { fnName: 'foo', fnArgs: [] }],
  ['"foo()"', 'foo()'],
  ['bad-fn-name()', 'bad-fn-name()'],
  ['0badFn()', '0badFn()'],
  ['foo(123)', { fnName: 'foo', fnArgs: [123] }],
  ['foo(abc,true,123)', { fnName: 'foo', fnArgs: ['abc', true, 123] }],
  ['foo( 1 , 2 , 3 )', { fnName: 'foo', fnArgs: [1, 2, 3] }],
  ['foo( \'sq\' , "dq" , `bt`, nq )', { fnName: 'foo', fnArgs: ['sq', 'dq', 'bt', 'nq'] }],
  ['foo(unq#uoted)', { fnName: 'foo', fnArgs: ['unq#uoted'] }],
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
  ['foo(fn#arg) #post-comment', { fnName: 'foo', fnArgs: ['fn#arg'] }],
]));
