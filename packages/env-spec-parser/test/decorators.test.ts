import { describe, it, expect } from 'vitest';
import { parseEnvSpecDotEnvFile } from '../src';

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
          expect(decoratorObject).toEqual(expectedDecorators);
        } catch (error) {
          // check if we expected an error
          if (!(expectedDecorators instanceof Error)) throw error;
        }
      });
    });
  };
}

describe('decorator parsing', basicDecoratorTests([
  // value parsing
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

  // whitespace before
  ['#@dec=1', { dec: 1 }],
  ['#\t@dec=1', { dec: 1 }],
  ['#   @dec=1', { dec: 1 }],


  ['# @dec=', new Error()],
  ['# @dec="', new Error()],
  ['# @dec="""', new Error()],
  ['# @dec="foo" not commented', new Error()],
  ['# @dec1@dec2', new Error()],
  ['# @dec1()', new Error()],
  ['# @', new Error()],
  ['# @0badDecorator', new Error()],
  ['# @bad-decorator', new Error()],

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

