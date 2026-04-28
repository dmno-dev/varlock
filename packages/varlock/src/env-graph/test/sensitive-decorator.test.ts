import {
  describe, test, expect, vi,
} from 'vitest';
import path from 'node:path';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';
import { EnvGraph, DotEnvFileDataSource } from '../index';
import { createEnvGraphDataType } from '../lib/data-types';

describe('@sensitive and @defaultSensitive tests', () => {
  test('no @defaultSensitive set - sensitive by default, can override', envFilesTest({
    envFile: outdent`
      TRUE=     # @sensitive=true
      FALSE=    # @sensitive=false
      UNDEF=    # @sensitive=undefined
      DEFAULT=
    `,
    expectSensitive: {
      TRUE: true, FALSE: false, UNDEF: true, DEFAULT: true,
    },
  }));

  test('static @defaultSensitive=true', envFilesTest({
    envFile: outdent`
      # @defaultSensitive=true
      # ---
      TRUE=     # @sensitive=true
      FALSE=    # @sensitive=false
      UNDEF=    # @sensitive=undefined
      DEFAULT=
    `,
    expectSensitive: {
      TRUE: true, FALSE: false, UNDEF: true, DEFAULT: true,
    },
  }));

  test('static @defaultSensitive=false', envFilesTest({
    envFile: outdent`
      # @defaultSensitive=false
      # ---
      TRUE=     # @sensitive=true
      FALSE=    # @sensitive=false
      UNDEF=    # @sensitive=undefined
      DEFAULT=
    `,
    expectSensitive: {
      TRUE: true, FALSE: false, UNDEF: false, DEFAULT: false,
    },
  }));

  test('@public and @sensitive mark items properly', envFilesTest({
    envFile: outdent`
      SENSITIVE=        # @sensitive
      SENSITIVE_TRUE=   # @sensitive=true
      SENSITIVE_FALSE=  # @sensitive=false
      SENSITIVE_UNDEF=  # @sensitive=undefined
      PUBLIC=           # @public
      PUBLIC_TRUE=      # @public=true
      PUBLIC_FALSE=     # @public=false
      PUBLIC_UNDEF=     # @public=undefined
    `,
    expectSensitive: {
      SENSITIVE: true,
      SENSITIVE_TRUE: true,
      SENSITIVE_FALSE: false,
      SENSITIVE_UNDEF: true, // stays as default
      PUBLIC: false,
      PUBLIC_TRUE: false,
      PUBLIC_FALSE: true,
      PUBLIC_UNDEF: true, // stays as default
    },
  }));

  test('@public and @sensitive can be overridden', envFilesTest({
    files: {
      '.env.schema': outdent`
        WAS_SENSITIVE= # @sensitive
        WAS_PUBLIC=    # @public
      `,
      '.env': outdent`
        WAS_SENSITIVE= # @public
        WAS_PUBLIC=    # @sensitive
      `,
    },
    expectSensitive: {
      WAS_SENSITIVE: false, WAS_PUBLIC: true,
    },
  }));

  describe('dynamic @sensitive', () => {
    test('dynamic @sensitive works', envFilesTest({
      envFile: outdent`
        TRUE=  # @sensitive=if(yes)
        FALSE= # @sensitive=if(0)
        UNDEF= # @sensitive=if(true, undefined) # uses default
      `,
      expectSensitive: {
        TRUE: true, FALSE: false, UNDEF: true,
      },
    }));

    test('dynamic @public works', envFilesTest({
      envFile: outdent`
        TRUE=  # @public=if(yes)
        FALSE= # @public=if(0)
        UNDEF= # @public=if(true, undefined) # uses default
      `,
      expectSensitive: {
        TRUE: false, FALSE: true, UNDEF: true,
      },
    }));
  });

  describe('inferFromPrefix() - use key prefix to infer sensitivity', () => {
    test('base case @defaultSensitive=inferFromPrefix', envFilesTest({
      envFile: outdent`
        # @defaultSensitive=inferFromPrefix(PUBLIC_)
        # ---
        PUBLIC_FOO=
        BAR=
      `,
      expectSensitive: { PUBLIC_FOO: false, BAR: true },
    }));

    test('key matches prefix is not sensitive (with explicit override)', envFilesTest({
      envFile: outdent`
        # @defaultSensitive=inferFromPrefix(PUBLIC_)
        # ---
        PUBLIC_FOO=
        # @sensitive=true
        SECRET_BAR=
      `,
      expectSensitive: { PUBLIC_FOO: false, SECRET_BAR: true },
    }));

    test('key does not match prefix is sensitive (with explicit override)', envFilesTest({
      envFile: outdent`
        # @defaultSensitive=inferFromPrefix(PUBLIC_)
        # ---
        # @sensitive=false
        FOO=
        PUBLIC_BAR=
      `,
      expectSensitive: { FOO: false, PUBLIC_BAR: false },
    }));

    test('explicit @sensitive overrides defaultSensitive', envFilesTest({
      envFile: outdent`
        # @defaultSensitive=inferFromPrefix(PUBLIC_)
        # ---
        # @sensitive=false
        SECRET_BAR=
        # @sensitive=true
        PUBLIC_FOO=
      `,
      expectSensitive: { SECRET_BAR: false, PUBLIC_FOO: true },
    }));
  });

  describe('explicit @sensitive overrides @defaultSensitive from other files', () => {
    test('@sensitive in schema wins over @defaultSensitive=false in local', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @sensitive
          ITEM_A=
        `,
        '.env.local': outdent`
          # @defaultSensitive=false
          # ---
          ITEM_A=secret
        `,
      },
      expectSensitive: { ITEM_A: true },
    }));

    test('@sensitive=false in schema wins over @defaultSensitive=true in local', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @sensitive=false
          ITEM_A=
        `,
        '.env.local': outdent`
          # @defaultSensitive=true
          # ---
          ITEM_A=value
        `,
      },
      expectSensitive: { ITEM_A: false },
    }));

    test('@public in schema wins over @defaultSensitive=true in local', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @public
          ITEM_A=
        `,
        '.env.local': outdent`
          # @defaultSensitive=true
          # ---
          ITEM_A=value
        `,
      },
      expectSensitive: { ITEM_A: false },
    }));

    test('@sensitive in local wins over @defaultSensitive=false in schema', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @defaultSensitive=false
          # ---
          ITEM_A=
        `,
        '.env.local': outdent`
          # @sensitive
          ITEM_A=secret
        `,
      },
      expectSensitive: { ITEM_A: true },
    }));

    test('@sensitive in schema wins over inferFromPrefix in local', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @sensitive
          PUBLIC_ITEM=
        `,
        '.env.local': outdent`
          # @defaultSensitive=inferFromPrefix(PUBLIC_)
          # ---
          PUBLIC_ITEM=value
        `,
      },
      expectSensitive: { PUBLIC_ITEM: true },
    }));

    test('items without explicit decorator still follow @defaultSensitive', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @sensitive
          EXPLICIT_SENSITIVE=
          NO_DECORATOR=
        `,
        '.env.local': outdent`
          # @defaultSensitive=false
          # ---
          EXPLICIT_SENSITIVE=secret
          NO_DECORATOR=value
        `,
      },
      expectSensitive: { EXPLICIT_SENSITIVE: true, NO_DECORATOR: false },
    }));
  });

  describe('data type with sensitive flag', () => {
    function dataTypeSensitiveTest(spec: {
      envFile: string;
      sensitiveDataType: boolean;
      expectSensitive: Record<string, boolean>;
    }) {
      return async () => {
        const currentDir = path.dirname(expect.getState().testPath!);
        vi.spyOn(process, 'cwd').mockReturnValue(currentDir);

        const g = new EnvGraph();
        g.registerDataType(createEnvGraphDataType({
          name: 'secret-token',
          sensitive: spec.sensitiveDataType,
        }));
        const source = new DotEnvFileDataSource('.env.schema', { overrideContents: spec.envFile });
        await g.setRootDataSource(source);
        await g.finishLoad();
        await g.resolveEnvValues();

        for (const [key, expected] of Object.entries(spec.expectSensitive)) {
          const item = g.configSchema[key];
          expect(item.isSensitive, `expected ${key} to be ${expected ? 'sensitive' : 'NOT sensitive'}`).toBe(expected);
        }
      };
    }

    test('data type sensitive=true makes items sensitive', dataTypeSensitiveTest({
      sensitiveDataType: true,
      envFile: outdent`
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: true, UNTYPED: true },
    }));

    test('data type sensitive=false makes items not sensitive (overrides default)', dataTypeSensitiveTest({
      sensitiveDataType: false,
      envFile: outdent`
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: false, UNTYPED: true },
    }));

    test('data type sensitive skips @defaultSensitive', dataTypeSensitiveTest({
      sensitiveDataType: true,
      envFile: outdent`
        # @defaultSensitive=false
        # ---
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: true, UNTYPED: false },
    }));

    test('explicit @sensitive=false overrides data type sensitive=true', dataTypeSensitiveTest({
      sensitiveDataType: true,
      envFile: outdent`
        # @sensitive=false
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: false, UNTYPED: true },
    }));

    test('explicit @public overrides data type sensitive=true', dataTypeSensitiveTest({
      sensitiveDataType: true,
      envFile: outdent`
        # @public
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: false, UNTYPED: true },
    }));

    test('explicit @sensitive=true overrides data type sensitive=false', dataTypeSensitiveTest({
      sensitiveDataType: false,
      envFile: outdent`
        # @sensitive
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: true, UNTYPED: true },
    }));
  });
});

// maybe not the right spot, but it is related to sensitivity and decorators
// we are checking redactLogs/preventLeaks are serialized correctly and can be disabled
describe('@redactLogs and @preventLeaks', () => {
  test('redactLogs and preventLeaks is on by default', envFilesTest({
    expectSerializedMatches: {
      settings: {
        redactLogs: true,
        preventLeaks: true,
      },
    },
  }));
  test('redactLogs and preventLeaks is on by default', envFilesTest({
    envFile: outdent`
      # @redactLogs=false
      # @preventLeaks=false
      # ---
    `,
    expectSerializedMatches: {
      settings: {
        redactLogs: false,
        preventLeaks: false,
      },
    },
  }));
});
