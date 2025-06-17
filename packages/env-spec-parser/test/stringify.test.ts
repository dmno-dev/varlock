import { describe, it, expect } from 'vitest';
import { envSpecUpdater, ParsedEnvSpecFile, parseEnvSpecDotEnvFile } from '../src';

function stringifyTests(tests: Array<[string, string]>) {
  return () => {
    tests.forEach((spec) => {
      const [label, inputStr] = spec;
      it(label, () => {
        const result = parseEnvSpecDotEnvFile(inputStr);
        const outputStr = result.toString();
        expect(outputStr).toEqual(inputStr);
      });
    });
  };
}

/* eslint-disable @stylistic/array-bracket-newline */
describe('re-stringification', stringifyTests([
  ['item value unquoted', 'VAL=foo'],
  ['item value with quotes', 'VAL="asdf asdf"'],
  ['item value with escaped quotes', 'VAL=`asdf \\`asdf`'],
  ['item value is function call', 'VAL=fnCall("val1", "val2")'],

  ['empty comment', '#'],
  ['empty comment with space', '# '],
  ['empty comment with multiple spaces', '#    '],
  ['comment leading spacing', '#     asdf'],
  ['comment trailing spacing', '# asdf   '],

  ['divider w/o space', '#---'],
  ['divider w/ space', '# ---'],
  ['divider w/ text', '# ------- asdkfjasdkfj -----'],

  ['full example', `

# this is a header
#    more header text
# @defaultRequired=true @another # asdfasd
# @import(../../.env)
# -------

VAL1=foo

# hello
# @required @foo=1 @bar=fn(1, 2)
# @decorator=foo # post-comment
VAL2=bar

# -------
VAL3=fnCall("val1", "val2")`,
  ],

]));

function updateTests(
  tests: Record<string, {
    input: string;
    transform: (file: ParsedEnvSpecFile) => void;
    expected: string;
  }>,
) {
  return () => {
    Object.entries(tests).forEach(([label, spec]) => {
      it(label, () => {
        const result = parseEnvSpecDotEnvFile(spec.input);
        spec.transform(result);
        const outputStr = result.toString();
        expect(outputStr).toEqual(spec.expected);
      });
    });
  };
}

describe('update helpers', updateTests({
  'add header': {
    input: 'VAL=foo',
    transform: (file) => {
      envSpecUpdater.ensureHeader(file, 'new header\nwith multiple lines');
    },
    expected: '# new header\n# with multiple lines\n# ----------\n\nVAL=foo',
  },
  'add root decorators - empty ': {
    input: '# header\n# ---',
    transform: (file) => {
      envSpecUpdater.setRootDecorator(file, 'defaultRequired', 'false');
      envSpecUpdater.setRootDecorator(file, 'defaultSensitive', 'false');
    },
    expected: '# header\n# @defaultRequired=false @defaultSensitive=false\n# ---',
  },
  'add root decorators - existing': {
    input: '# header\n# @foo @bar=hello @import(../.env)\n# ---',
    transform: (file) => {
      envSpecUpdater.setRootDecorator(file, 'import', '../../.env', { bareFnArgs: true });
      envSpecUpdater.setRootDecorator(file, 'bar', '"bye bye"');
    },
    expected: '# header\n# @foo @bar="bye bye" @import(../../.env)\n# ---',
  },
  'add root decorators - bare fn call w/ key value args': {
    input: '# header\n# ---',
    transform: (file) => {
      envSpecUpdater.setRootDecorator(file, 'generateTypes', 'lang=ts, path=env.d.ts', { bareFnArgs: true });
    },
    expected: '# header\n# @generateTypes(lang=ts, path=env.d.ts)\n# ---',
  },

  'add root decorators - new line': {
    input: '# header\n# @foo # super long line of comments so it should push new one to the next line\n# ---',
    transform: (file) => {
      envSpecUpdater.setRootDecorator(file, 'new', '"on next line"');
    },
    expected: '# header\n# @foo # super long line of comments so it should push new one to the next line\n# @new="on next line"\n# ---',
  },
  'add root decorators - comment': {
    input: '# header\n# ---',
    transform: (file) => {
      envSpecUpdater.setRootDecorator(file, 'foo', 'bar', { comment: 'post comment' });
    },
    expected: '# header\n# @foo=bar # post comment\n# ---',
  },
  'add item decorator - nonexistant item': {
    input: '',
    transform: (file) => {
      envSpecUpdater.setItemDecorator(file, 'ITEM1', 'd1', 'v1');
      envSpecUpdater.setItemDecorator(file, 'ITEM1', 'd2', 'true');
    },
    expected: '# @d1=v1 @d2\nITEM1=',
  },
  'add item decorator - existing item, no decorators': {
    input: 'ITEM1=',
    transform: (file) => {
      envSpecUpdater.setItemDecorator(file, 'ITEM1', 'd1', 'v1');
    },
    expected: '# @d1=v1\nITEM1=',
  },
  'add item decorator - existing item w/ decorators, new decorator': {
    input: '# @foo\nITEM1=',
    transform: (file) => {
      envSpecUpdater.setItemDecorator(file, 'ITEM1', 'd1', 'v1');
    },
    expected: '# @foo @d1=v1\nITEM1=',
  },
  'add item decorator - existing decorator': {
    input: '# @foo\nITEM1=',
    transform: (file) => {
      envSpecUpdater.setItemDecorator(file, 'ITEM1', 'foo', 'bar');
    },
    expected: '# @foo=bar\nITEM1=',
  },
}));
