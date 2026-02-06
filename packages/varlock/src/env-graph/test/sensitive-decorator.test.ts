import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

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

  test.todo('data type sensitive can set sensitivity');
  test.todo('data type sensitive is not overridden by item decorators');
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
