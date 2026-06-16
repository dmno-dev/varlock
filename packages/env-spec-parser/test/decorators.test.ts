import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import {
  ParsedEnvSpecFunctionCall, ParsedEnvSpecFunctionArgs, ParsedEnvSpecStaticValue,
  ParsedEnvSpecObjectLiteral, ParsedEnvSpecArrayLiteral,
  parseEnvSpecDotEnvFile,
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
              expect((decoratorObject[key].value as any).value).toEqual(expectedValue);
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

  describe('object/array literal values `@dec={k=v}` / `@dec=[a,b]`', () => {
    it('parses `{k=v}` as an object literal (not a bare fn call)', () => {
      const result = parseEnvSpecDotEnvFile('# @sensitive={preventLeaks=false}\nVAL=');
      const dec = result.configItems[0].decoratorsObject.sensitive;
      expect(dec.isBareFnCall).toBe(false);
      expectInstanceOf(dec.value, ParsedEnvSpecObjectLiteral);
      expect((dec.value as ParsedEnvSpecObjectLiteral).simplifiedValue).toEqual({ preventLeaks: false });
    });

    it('parses `[a, b, c]` as an array literal', () => {
      const result = parseEnvSpecDotEnvFile('# @dec=[a, b, c]\nVAL=');
      const dec = result.configItems[0].decoratorsObject.dec;
      expectInstanceOf(dec.value, ParsedEnvSpecArrayLiteral);
      expect((dec.value as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual(['a', 'b', 'c']);
    });

    it('supports nesting inside function args', () => {
      const result = parseEnvSpecDotEnvFile('# @dec=fn(opts={x=1}, items=[1, 2])\nVAL=');
      const dec = result.configItems[0].decoratorsObject.dec;
      expectInstanceOf(dec.value, ParsedEnvSpecFunctionCall);
      expect(dec.toString()).toBe('@dec=fn(opts={x=1}, items=[1, 2])');
    });

    it('round-trips via toString()', () => {
      const result = parseEnvSpecDotEnvFile('# @sensitive={preventLeaks=false}\nVAL=');
      expect(result.configItems[0].decoratorsObject.sensitive.toString()).toBe('@sensitive={preventLeaks=false}');
    });
  });

  describe('multi-line object/array literals (`#` continuation)', () => {
    it('parses a multi-line array literal', () => {
      const result = parseEnvSpecDotEnvFile(outdent`
        # @dec=[
        #   a,
        #   b,
        #   c,
        # ]
        VAL=
      `);
      const dec = result.configItems[0].decoratorsObject.dec;
      expectInstanceOf(dec.value, ParsedEnvSpecArrayLiteral);
      expect((dec.value as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual(['a', 'b', 'c']);
    });

    it('parses a multi-line array without a trailing comma', () => {
      const result = parseEnvSpecDotEnvFile(outdent`
        # @dec=[
        #   a,
        #   b
        # ]
        VAL=
      `);
      const dec = result.configItems[0].decoratorsObject.dec;
      expect((dec.value as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual(['a', 'b']);
    });

    it('parses a multi-line object literal', () => {
      const result = parseEnvSpecDotEnvFile(outdent`
        # @sensitive={
        #   preventLeaks=false,
        #   foo=bar,
        # }
        VAL=
      `);
      const dec = result.configItems[0].decoratorsObject.sensitive;
      expectInstanceOf(dec.value, ParsedEnvSpecObjectLiteral);
      expect((dec.value as ParsedEnvSpecObjectLiteral).simplifiedValue).toEqual({ preventLeaks: false, foo: 'bar' });
    });

    it('parses a multi-line array passed as a function arg (e.g. `@import(..., pick=[...])`)', () => {
      const result = parseEnvSpecDotEnvFile(outdent`
        # @import(
        #   ./.env.shared,
        #   pick=[
        #     KEY1,
        #     KEY2,
        #     KEY3,
        #   ],
        # )
        VAL=
      `);
      const dec = result.configItems[0].decoratorsObject.import;
      expect(dec.isBareFnCall).toBe(true);
      const args = dec.bareFnArgs!;
      expectInstanceOf(args.values[0], ParsedEnvSpecStaticValue);
      expect((args.values[0] as ParsedEnvSpecStaticValue).value).toBe('./.env.shared');
      const pick = args.values[1] as any;
      expect(pick.key).toBe('pick');
      expectInstanceOf(pick.value, ParsedEnvSpecArrayLiteral);
      expect((pick.value as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual(['KEY1', 'KEY2', 'KEY3']);
    });

    it('parses nested multi-line literals', () => {
      const result = parseEnvSpecDotEnvFile(outdent`
        # @dec={
        #   items=[
        #     1,
        #     2,
        #   ],
        #   opts={
        #     retry=true,
        #   },
        # }
        VAL=
      `);
      const dec = result.configItems[0].decoratorsObject.dec;
      expect((dec.value as ParsedEnvSpecObjectLiteral).simplifiedValue).toEqual({
        items: [1, 2],
        opts: { retry: true },
      });
    });

    it('round-trips a multi-line literal to a single-line toString()', () => {
      const result = parseEnvSpecDotEnvFile(outdent`
        # @dec=[
        #   a,
        #   b,
        # ]
        VAL=
      `);
      expect(result.configItems[0].decoratorsObject.dec.toString()).toBe('@dec=[a, b]');
    });

    it('skips commented-out entries and trailing post-comments inside a multi-line literal', () => {
      const result = parseEnvSpecDotEnvFile(outdent`
        # @dec=[
        #   VAL1,
        # # COMMENTED_VAL,
        #   VAL3, # post comment
        # ]
        VAL=
      `);
      const dec = result.configItems[0].decoratorsObject.dec;
      expect((dec.value as ParsedEnvSpecArrayLiteral).simplifiedValue).toEqual(['VAL1', 'VAL3']);
    });

    it('skips comments inside a multi-line object literal', () => {
      const result = parseEnvSpecDotEnvFile(outdent`
        # @sensitive={
        #   preventLeaks=false, # leaves the system intentionally
        #   # enabled=false,
        # }
        VAL=
      `);
      const dec = result.configItems[0].decoratorsObject.sensitive;
      expect((dec.value as ParsedEnvSpecObjectLiteral).simplifiedValue).toEqual({ preventLeaks: false });
    });

    it('does not swallow following config items when continuation lines omit `#`', () => {
      // a `[` without `#`-prefixed continuation lines can't form a multi-line array,
      // so it falls back to a plain string value and the following lines remain
      // independent config items rather than being absorbed into the literal.
      const result = parseEnvSpecDotEnvFile(outdent`
        # @dec=[
        KEY1=v1
        KEY2=v2
        VAL=
      `);
      expect(result.configItems.map((i) => i.key)).toEqual(['KEY1', 'KEY2', 'VAL']);
    });
  });

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
      label: 'multi-line dec fn skips a commented-out interior line',
      comments: outdent`
        # @import(
        #   ./.env.import,
        # #  ITEM1,
        #   ITEM2,
        # )
      `,
      expected: { import: { fnName: undefined, fnArgs: ['./.env.import', 'ITEM2'] } },
    },
    {
      label: 'multi-line dec fn skips a trailing post-comment on an arg',
      comments: outdent`
        # @import(
        #   ./.env.import,
        #   ITEM1, # primary
        #   ITEM2,
        # )
      `,
      expected: { import: { fnName: undefined, fnArgs: ['./.env.import', 'ITEM1', 'ITEM2'] } },
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
    ['# @dec="""', new Error()],
    ['# @dec1@dec2', new Error()],
    ['# @', new Error()],
    ['# @0badDecorator', new Error()],
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

  describe('warnings on decorator-like comments with trailing text', () => {
    function parseDecorators(comments: string) {
      const result = parseEnvSpecDotEnvFile(`${comments}\nVAL=`);
      return result.configItems[0].decoratorsArray;
    }

    // stray text is attached to the preceding decorator
    it('should attach stray text to decorator for `# @foo blah`', () => {
      const decs = parseDecorators('# @foo blah');
      expect(decs).toHaveLength(1);
      expect(decs[0].strayText).toBe('blah');
    });

    it('should attach stray text for `# @see https://example.com`', () => {
      const decs = parseDecorators('# @see https://example.com');
      expect(decs).toHaveLength(1);
      expect(decs[0].strayText).toBe('https://example.com');
    });

    // colon after decorator name is also a warning (via hasInvalidName)
    it('should flag `# @todo: fix me later` as invalid name + stray text', () => {
      const decs = parseDecorators('# @todo: fix me later');
      expect(decs).toHaveLength(1);
      expect(decs[0].hasInvalidName).toBe(true);
      expect(decs[0].strayText).toBe('fix me later');
    });

    it('should flag `# @todo:` as invalid name', () => {
      const decs = parseDecorators('# @todo:');
      expect(decs).toHaveLength(1);
      expect(decs[0].hasInvalidName).toBe(true);
    });

    it('should attach stray text to last decorator for `# @dec1 @dec2 bad comment`', () => {
      const decs = parseDecorators('# @dec1 @dec2 bad comment');
      expect(decs).toHaveLength(2);
      expect(decs[0].name).toBe('dec1');
      expect(decs[0].strayText).toBeUndefined();
      expect(decs[1].name).toBe('dec2');
      expect(decs[1].strayText).toBe('bad comment');
    });

    it('should attach stray text for `# @dec=foo bar`', () => {
      const decs = parseDecorators('# @dec=foo bar');
      expect(decs).toHaveLength(1);
      expect(decs[0].strayText).toBe('bar');
    });

    it('should attach stray text for `# @dec="foo" not commented`', () => {
      const decs = parseDecorators('# @dec="foo" not commented');
      expect(decs).toHaveLength(1);
      expect(decs[0].strayText).toBe('not commented');
    });

    // invalid decorator names (hyphens, colons) produce hasInvalidName
    it('should flag `# @bad-decorator` as invalid name', () => {
      const decs = parseDecorators('# @bad-decorator');
      expect(decs).toHaveLength(1);
      expect(decs[0].hasInvalidName).toBe(true);
    });

    it('should flag only the bad decorator in `# @okDec @badDecWithColon:`', () => {
      const decs = parseDecorators('# @okDec @badDecWithColon:');
      expect(decs).toHaveLength(2);
      expect(decs[0].hasInvalidName).toBe(false);
      expect(decs[1].hasInvalidName).toBe(true);
    });

    // post-decorator comments prefixed with # are valid
    it('should NOT have stray text for `# @dec # this is ok` (post comment)', () => {
      const decs = parseDecorators('# @dec # this is ok');
      expect(decs).toHaveLength(1);
      expect(decs[0].strayText).toBeUndefined();
    });

    // decorators after stray text are still parsed as real decorators
    it('should parse both decorators in `# @dec1 extra @dec2 extra` with stray text on each', () => {
      const decs = parseDecorators('# @dec1 extra @dec2 extra');
      expect(decs).toHaveLength(2);
      expect(decs[0].name).toBe('dec1');
      expect(decs[0].strayText).toBe('extra');
      expect(decs[1].name).toBe('dec2');
      expect(decs[1].strayText).toBe('extra');
    });

    it('should attach stray text to decorator', () => {
      const decs = parseDecorators('# @dec1 extra');
      expect(decs).toHaveLength(1);
      expect(decs[0].strayText).toBe('extra');
    });
  });
});
