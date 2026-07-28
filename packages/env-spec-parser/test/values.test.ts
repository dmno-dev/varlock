import { describe, it, expect } from 'vitest';
import ansis from 'ansis';
import {
  ParsedEnvSpecFunctionCall, ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecStaticValue, ParsedEnvSpecArrayLiteral, ParsedEnvSpecObjectLiteral,
  parseEnvSpecDotEnvFile,
} from '../src';
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

describe('regex-like strings and paths with slashes', () => {
  it('regex-like strings are parsed as plain strings in config values', () => {
    const result = parseEnvSpecDotEnvFile('VAL=/foo/');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecStaticValue);
    expect(valNode.value).toEqual('/foo/');
  });

  it('unquoted path with multiple slashes is parsed correctly', () => {
    const result = parseEnvSpecDotEnvFile('VAL=/folder/foo/bar');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecStaticValue);
    expect(valNode.value).toEqual('/folder/foo/bar');
  });

  it('unquoted absolute path with trailing slash is parsed correctly', () => {
    const result = parseEnvSpecDotEnvFile('VAL=/usr/local/bin/');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecStaticValue);
    expect(valNode.value).toEqual('/usr/local/bin/');
  });

  it('quoted path with slashes is parsed correctly', () => {
    const result = parseEnvSpecDotEnvFile('VAL="/folder/foo/bar"');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecStaticValue);
    expect(valNode.value).toEqual('/folder/foo/bar');
  });

  it('single-quoted path with slashes is parsed correctly', () => {
    const result = parseEnvSpecDotEnvFile("VAL='/folder/foo/bar'");
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecStaticValue);
    expect(valNode.value).toEqual('/folder/foo/bar');
  });

  it('path in function arg is parsed as plain string', () => {
    const result = parseEnvSpecDotEnvFile('VAL=foo(/some/path, bar)');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecFunctionCall);
    const args = valNode.data.args.values;
    expectInstanceOf(args[0], ParsedEnvSpecStaticValue);
    expect(args[0].value).toEqual('/some/path');
  });

  it('path in key=value function arg is parsed as plain string', () => {
    const result = parseEnvSpecDotEnvFile('VAL=foo(path=/some/dir/file.txt)');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecFunctionCall);
    const args = valNode.data.args.values;
    expectInstanceOf(args[0], ParsedEnvSpecKeyValuePair);
    expectInstanceOf(args[0].value, ParsedEnvSpecStaticValue);
    expect(args[0].value.value).toEqual('/some/dir/file.txt');
  });

  it('regex-like strings inside function args are parsed as plain strings', () => {
    const result = parseEnvSpecDotEnvFile('VAL=foo(/^dev.*/, bar)');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecFunctionCall);
    expect(valNode.name).toEqual('foo');
    const args = valNode.data.args.values;
    expectInstanceOf(args[0], ParsedEnvSpecStaticValue);
    expect(args[0].value).toEqual('/^dev.*/');
  });

  it('regex-like strings in key=value function args are parsed as plain strings', () => {
    // /^https:\/\// in env file content — now parsed as unquoted string, not regex literal
    const result = parseEnvSpecDotEnvFile('VAL=foo(matches=/^https:\\/\\//)');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecFunctionCall);
    const args = valNode.data.args.values;
    expectInstanceOf(args[0], ParsedEnvSpecKeyValuePair);
    expectInstanceOf(args[0].value, ParsedEnvSpecStaticValue);
    // The value includes the full unquoted string up to the closing )
    // In the env file: /^https:\/\// (the trailing / that was previously the regex closing delimiter is now part of the string)
    expect(args[0].value.value).toEqual('/^https:\\/\\//');
  });
});

describe('array literal item values', () => {
  it('parses [a, b] as an array literal', () => {
    const result = parseEnvSpecDotEnvFile('VAL=[a, b]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    expect(valNode.simplifiedValue).toEqual(['a', 'b']);
  });

  it('parses quoted elements in array literals', () => {
    const result = parseEnvSpecDotEnvFile('VAL=["a@example.com", "b@example.com"]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    expect(valNode.simplifiedValue).toEqual(['a@example.com', 'b@example.com']);
  });

  it('parses empty array literal', () => {
    const result = parseEnvSpecDotEnvFile('VAL=[]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    expect(valNode.simplifiedValue).toEqual([]);
  });

  it('auto-coerces unquoted scalar elements', () => {
    const result = parseEnvSpecDotEnvFile('VAL=[1, true, x]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    expect(valNode.simplifiedValue).toEqual([1, true, 'x']);
  });

  it('supports multi-line array literals with trailing comma', () => {
    const result = parseEnvSpecDotEnvFile('VAL=[\n  one,\n  two,\n]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    expect(valNode.simplifiedValue).toEqual(['one', 'two']);
  });

  // eslint-disable-next-line no-template-curly-in-string
  it('expands ${REF} within array elements', () => {
    // eslint-disable-next-line no-template-curly-in-string
    const result = parseEnvSpecDotEnvFile('VAL=[a, ${OTHER}]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    const el1 = valNode.values[1];
    expectInstanceOf(el1, ParsedEnvSpecFunctionCall);
    expect(el1.name).toEqual('ref');
  });

  // eslint-disable-next-line no-template-curly-in-string
  it('expands ${REF} with adjacent text into concat within elements', () => {
    // eslint-disable-next-line no-template-curly-in-string
    const result = parseEnvSpecDotEnvFile('VAL=[${A}-suffix, b]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    const el0 = valNode.values[0];
    expectInstanceOf(el0, ParsedEnvSpecFunctionCall);
    expect(el0.name).toEqual('concat');
  });

  it('supports nested arrays and objects', () => {
    const result = parseEnvSpecDotEnvFile('VAL=[a, [b, c], {k=v}]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    expect(valNode.simplifiedValue).toEqual(['a', ['b', 'c'], { k: 'v' }]);
  });

  it('supports post comments after array literals', () => {
    const result = parseEnvSpecDotEnvFile('VAL=[a, b] # comment');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    expect(valNode.simplifiedValue).toEqual(['a', 'b']);
  });
});

describe('comments and hashes within array literals', () => {
  it('supports trailing comments after elements', () => {
    const result = parseEnvSpecDotEnvFile('VAL=[\n  one, # first\n  two # last\n]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    expect(valNode.simplifiedValue).toEqual(['one', 'two']);
  });

  it('a hash glued to an unquoted element stays part of the value', () => {
    const result = parseEnvSpecDotEnvFile('VAL=[color#1, plain]');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecArrayLiteral);
    expect(valNode.simplifiedValue).toEqual(['color#1', 'plain']);
  });
});

describe('object literal item values', () => {
  it('parses {k=v} as an object literal', () => {
    const result = parseEnvSpecDotEnvFile('VAL={k=v, n=2}');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecObjectLiteral);
    expect(valNode.simplifiedValue).toEqual({ k: 'v', n: 2 });
  });

  it('parses empty object literal', () => {
    const result = parseEnvSpecDotEnvFile('VAL={}');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecObjectLiteral);
    expect(valNode.simplifiedValue).toEqual({});
  });


  it('supports trailing comments after entries', () => {
    const result = parseEnvSpecDotEnvFile('VAL={\n  api=https://a.com, # main api\n  docs=https://b.com # docs site\n}');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecObjectLiteral);
    expect(valNode.simplifiedValue).toEqual({ api: 'https://a.com', docs: 'https://b.com' });
  });

  it('supports multi-line object literals with trailing comma', () => {
    const result = parseEnvSpecDotEnvFile('VAL={\n  api=https://a.com,\n  # comment\n  docs=https://b.com,\n}');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecObjectLiteral);
    expect(valNode.simplifiedValue).toEqual({ api: 'https://a.com', docs: 'https://b.com' });
  });

  // eslint-disable-next-line no-template-curly-in-string
  it('expands ${REF} within object values', () => {
    // eslint-disable-next-line no-template-curly-in-string
    const result = parseEnvSpecDotEnvFile('VAL={url=${BASE}, n=2}');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecObjectLiteral);
    const urlVal = valNode.values[0].value;
    expectInstanceOf(urlVal, ParsedEnvSpecFunctionCall);
    expect(urlVal.name).toEqual('ref');
  });

  it('JSON-style objects fall back to plain strings', () => {
    // `:`-separated pairs are not env-spec object syntax, so the literal parse fails
    // and the value falls through to a plain unquoted string (previous behavior)
    const result = parseEnvSpecDotEnvFile('VAL={"json": "blob"}');
    const valNode = result.configItems[0].value;
    expectInstanceOf(valNode, ParsedEnvSpecStaticValue);
    expect(valNode.value).toEqual('{"json": "blob"}');
  });
});
