import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';
import { SchemaError } from '../lib/errors';


describe('required decorators', () => {
  test('@required and @optional mark items properly', envFilesTest({
    files: {
      '.env.schema': outdent`
        REQUIRED=       # @required
        REQUIRED_TRUE=  # @required=true
        REQUIRED_FALSE= # @required=false
        REQUIRED_UNDEF= # @required=undefined
        OPTIONAL=       # @optional
        OPTIONAL_TRUE=  # @optional=true
        OPTIONAL_FALSE= # @optional=false
        OPTIONAL_UNDEF= # @optional=undefined
      `,
    },
    expectRequired: {
      REQUIRED: true,
      REQUIRED_TRUE: true,
      REQUIRED_FALSE: false,
      REQUIRED_UNDEF: true, // stays as default
      OPTIONAL: false,
      OPTIONAL_TRUE: false,
      OPTIONAL_FALSE: true,
      OPTIONAL_UNDEF: true,
    },
  }));
  test('@required and @optional can be overridden', envFilesTest({
    files: {
      '.env.schema': outdent`
        WAS_REQUIRED= # @required
        WAS_OPTIONAL= # @optional
      `,
      '.env': outdent`
        WAS_REQUIRED= # @optional
        WAS_OPTIONAL= # @required
      `,
    },
    expectRequired: {
      WAS_REQUIRED: false, WAS_OPTIONAL: true,
    },
  }));
  test('without any @defaultRequired, items are required by default', envFilesTest({
    files: {
      '.env.schema': outdent`
        WITH_VALUE=bar
        NO_VALUE=
        EXPLICIT_REQUIRED= # @required
        EXPLICIT_OPTIONAL= # @optional
      `,
    },
    expectRequired: {
      WITH_VALUE: true, NO_VALUE: true, EXPLICIT_REQUIRED: true, EXPLICIT_OPTIONAL: false,
    },
  }));
  test('@defaultRequired=true makes all required by default', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @defaultRequired=true
        # ---
        WITH_VALUE=bar
        NO_VALUE=
        EXPLICIT_REQUIRED= # @required
        EXPLICIT_OPTIONAL= # @optional
      `,
    },
    expectRequired: {
      WITH_VALUE: true, NO_VALUE: true, EXPLICIT_REQUIRED: true, EXPLICIT_OPTIONAL: false,
    },
  }));

  test('@defaultRequired=false makes all optional by default', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @defaultRequired=false
        # ---
        WITH_VALUE=bar
        NO_VALUE=
        EXPLICIT_REQUIRED= # @required
        EXPLICIT_OPTIONAL= # @optional
      `,
    },
    expectRequired: {
      WITH_VALUE: false, NO_VALUE: false, EXPLICIT_REQUIRED: true, EXPLICIT_OPTIONAL: false,
    },
  }));
  test('@defaultRequired=infer will infer based on if a value is present', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @defaultRequired=infer
        # ---
        EMPTY=
        UNDEFINED=undefined
        EMPTY_STRING=''
        STATIC_VALUE=foo
        FN_VALUE=eq(1, 1)
        OVERRIDE_REQUIRED=    # @required
        OVERRIDE_OPTIONAL=foo # @optional
      `,
    },
    expectRequired: {
      EMPTY: false,
      UNDEFINED: false,
      EMPTY_STRING: false,
      STATIC_VALUE: true,
      FN_VALUE: true,
      OVERRIDE_REQUIRED: true,
      OVERRIDE_OPTIONAL: false,
    },
  }));
  test('@defaultRequired=infer should only consider values set in same source', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @defaultRequired=infer
        # ---
        NOT_EMPTY_IN_SCHEMA=foo
        EMPTY_IN_SCHEMA=
      `,
      '.env': outdent`
        NOT_EMPTY_IN_SCHEMA=
        EMPTY_IN_SCHEMA=bar
      `,
    },
    expectRequired: { NOT_EMPTY_IN_SCHEMA: true, EMPTY_IN_SCHEMA: false },
  }));
  test('@defaultRequired=infer inferred items can be overridden in other sources', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @defaultRequired=infer
        # ---
        WAS_REQUIRED=foo
        WAS_OPTIONAL=
      `,
      '.env': outdent`
        WAS_REQUIRED= # @optional
        WAS_OPTIONAL= # @required
      `,
    },
    expectRequired: { WAS_REQUIRED: false, WAS_OPTIONAL: true },
  }));

  // ! previously had this behaviour, but not sure it's necessary
  // test('@defaultRequired=infer does not have any effect in non schema file', envFilesTest({
  //   files: {
  //     '.env': outdent`
  //       # @defaultRequired=infer
  //       # ---
  //       FOO=
  //       BAR=
  //     `,
  //   },
  //   expectRequired: { FOO: true, BAR: true },
  // }));
  test('cannot use @required and @optional together', envFilesTest({
    files: {
      '.env.schema': outdent`
        ERROR= # @required @optional
      `,
    },
    expectRequired: { ERROR: SchemaError },
  }));
  test('@required and @optional only accept boolean static values', envFilesTest({
    files: {
      '.env.schema': outdent`
        ERROR1= # @required=123
        ERROR2= # @required="true"
        ERROR3= # @optional=123
      `,
    },
    expectRequired: {
      ERROR1: SchemaError,
      ERROR2: SchemaError,
      ERROR3: SchemaError,
    },
  }));
  describe('@required with forEnv()', () => {
    test('@required can use `forEnv()` helper to be set based on current envFlag', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @currentEnv=$APP_ENV @defaultRequired=false
          # ---
          APP_ENV=staging
          REQ_FOR_DEV=      # @required=forEnv(dev)
          REQ_FOR_STAGING=  # @required=forEnv(staging)
          REQ_FOR_MULTIPLE= # @required=forEnv(staging, prod)
        `,
      },
      expectRequired: {
        REQ_FOR_DEV: false,
        REQ_FOR_STAGING: true,
        REQ_FOR_MULTIPLE: true,
      },
    }));
    test('@optional can also use `forEnv()`', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @currentEnv=$APP_ENV @defaultRequired=true
          # ---
          APP_ENV=staging
          OPT_FOR_DEV=      # @optional=forEnv(dev)
          OPT_FOR_STAGING=  # @optional=forEnv(staging)
          OPT_FOR_MULTIPLE= # @optional=forEnv(staging, prod)
        `,
      },
      expectRequired: {
        OPT_FOR_DEV: true,
        OPT_FOR_STAGING: false,
        OPT_FOR_MULTIPLE: false,
      },
    }));
    test('`forEnv()` helper is not usable if no envFlag is set', envFilesTest({
      files: {
        '.env.schema': outdent`
          REQ_FOR_DEV=      # @required=forEnv(dev)
        `,
      },
      expectRequired: {
        REQ_FOR_DEV: SchemaError,
      },
    }));
  });
  describe('dynamic @required based on other items', () => {
    test('dynamic @required works', envFilesTest({
      files: {
        '.env.schema': outdent`
          REQ_IF_FOO= # @required=eq($OTHER, foo)
          REQ_IF_BAR= # @required=eq($OTHER, bar)
          OTHER=foo
          REQ_IF_T= # @required=if(yes)
          REQ_IF_F= # @required=if(0)
        `,
      },
      expectRequired: {
        REQ_IF_FOO: true,
        REQ_IF_BAR: false,
        REQ_IF_T: true,
        REQ_IF_F: false,
      },
    }));
    test('ensure @required isDynamic is correct (affects type generation)', envFilesTest({
      files: {
        '.env.schema': outdent`
          TRUE= # @required
          FALSE= # @required=false
          UNDEF= # @required=undefined
          REQ_FN= # @required=if(0)
          REQ_FN_UNDEF= # @required=if(true, undefined)
        `,
      },
      expectRequiredIsDynamic: {
        TRUE: false,
        FALSE: false,
        UNDEF: false,
        REQ_FN: true,
        REQ_FN_UNDEF: true,
      },
    }));
  });
});
