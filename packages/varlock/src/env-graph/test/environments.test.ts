import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

describe('@currentEnv and .env.* file loading logic', () => {
  test('@currentEnv must point to an item present in same file', envFilesTest({
    overrideValues: { APP_ENV: 'test' },
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        OTHER_ITEM=foo
      `,
      '.env': 'APP_ENV=dev',
    },
    loadingError: true,
  }));

  test('all .env.* files are loaded in correct precedence order', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
        ITEM2=val-from-.env.schema
        ITEM3=val-from-.env.schema
        ITEM4=val-from-.env.schema
        ITEM5=val-from-.env.schema
      `,
      '.env': outdent`
        ITEM2=val-from-.env
        ITEM3=val-from-.env
        ITEM4=val-from-.env
        ITEM5=val-from-.env
      `,
      '.env.local': outdent`
        ITEM3=val-from-.env.local
        ITEM4=val-from-.env.local
        ITEM5=val-from-.env.local
      `,
      '.env.dev': outdent`
        ITEM4=val-from-.env.dev
        ITEM5=val-from-.env.dev
      `,
      '.env.dev.local': outdent`
        ITEM5=val-from-.env.dev.local
      `,
      // not loaded
      '.env.prod': outdent`
        ITEM1=val-from-.env.prod
        ITEM2=val-from-.env.prod
        ITEM3=val-from-.env.prod
        ITEM4=val-from-.env.prod
        ITEM5=val-from-.env.prod
      `,
    },
    expectValues: {
      ITEM1: 'val-from-.env.schema',
      ITEM2: 'val-from-.env',
      ITEM3: 'val-from-.env.local',
      ITEM4: 'val-from-.env.dev',
      ITEM5: 'val-from-.env.dev.local',
    },
  }));

  test('correct env-specific files are loaded when environment is overridden', envFilesTest({
    overrideValues: { APP_ENV: 'prod' },
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
      '.env.dev': 'ITEM1=val-from-.env.dev',
      '.env.prod': 'ITEM1=val-from-.env.prod',
    },
    expectValues: {
      ITEM1: 'val-from-.env.prod',
    },
  }));

  test('@envFlag also works', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @envFlag=APP_ENV
        # ---
        APP_ENV=dev
      `,
      '.env.dev': outdent`
        FOO=bar
      `,
    },
    expectValues: {
      FOO: 'bar',

    },
  }));
  test('@envFlag and @currentEnv cannot be used together', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @envFlag=APP_ENV
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
      `,
    },
    loadingError: true,
  }));

  // some other tools (e.g. dotenv-expand, Next.js) automatically skip .env.local for test mode
  // while other tools (Vite) do not. We decided to be more explicit, and give helpers to opt into that behaviour
  test('.env.local IS loaded if currentEnv value is "test"', envFilesTest({
    overrideValues: { APP_ENV: 'test' },
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
      '.env.local': 'ITEM1=val-from-.env.local',
    },
    expectValues: {
      ITEM1: 'val-from-.env.local',
    },
  }));

  test('.env.local can be skipped using `@disable=forEnv(test)`', envFilesTest({
    overrideValues: { APP_ENV: 'test' },
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
      '.env.local': outdent`
        # @disable=forEnv(test)
        # ---
        ITEM1=val-from-.env.local
      `,
    },
    expectValues: {
      ITEM1: 'val-from-.env.schema',
    },
  }));

  test('currentEnv can be set from .env.local', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
      '.env.local': outdent`
        APP_ENV=staging
        ITEM1=val-from-.env.local
      `,
      '.env.staging': outdent`
        ITEM1=val-from-.env.staging
      `,
    },
    expectValues: {
      ITEM1: 'val-from-.env.staging',
    },
  }));

  test('currentEnv can use a function and be based on another item', envFilesTest({
    overrideValues: { CURRENT_BRANCH: 'prod' },
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=fallback($CURRENT_BRANCH, dev)
        CURRENT_BRANCH=
        ITEM1=val-from-.env.schema
      `,
      '.env.dev': 'ITEM1=val-from-.env.dev',
      '.env.prod': 'ITEM1=val-from-.env.prod',
    },
    expectValues: {
      ITEM1: 'val-from-.env.prod',
    },
  }));

  test('imported directory can reuse the existing currentEnv', envFilesTest({
    overrideValues: { APP_ENV: 'dev' },
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./dir/)
        # ---
        APP_ENV=dev
      `,
      'dir/.env.dev': outdent`
        IMPORTED_ITEM=foo
      `,
    },
    expectValues: {
      IMPORTED_ITEM: 'foo',
    },
  }));

  test('imported directory can use its own currentEnv - import everything', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./dir/)
        # ---
        APP_ENV=dev
      `,
      '.env.dev': 'BASE_ITEM=dev-val',
      '.env.prod': 'BASE_ITEM=prod-val',
      'dir/.env.schema': outdent`
        # @currentEnv=$APP_ENV2
        # ---
        APP_ENV2=prod
      `,
      'dir/.env.dev': 'IMPORTED_ITEM=dev-val',
      'dir/.env.prod': 'IMPORTED_ITEM=prod-val',
    },
    expectValues: {
      BASE_ITEM: 'dev-val',
      IMPORTED_ITEM: 'prod-val',
    },
  }));
  test('imported directory can use its own currentEnv - with partial import', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./dir/, APP_ENV2, IMPORTED_ITEM)
        # ---
        APP_ENV=dev
      `,
      '.env.dev': 'BASE_ITEM=dev-val',
      '.env.prod': 'BASE_ITEM=prod-val',
      'dir/.env.schema': outdent`
        # @currentEnv=$APP_ENV2
        # ---
        APP_ENV2=prod
      `,
      'dir/.env.dev': 'IMPORTED_ITEM=dev-val',
      'dir/.env.prod': 'IMPORTED_ITEM=prod-val',
    },
    expectValues: {
      BASE_ITEM: 'dev-val',
      IMPORTED_ITEM: 'prod-val',
    },
  }));
  test('imported directory with its own currentEnv must include env flag in import list', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./dir/, IMPORTED_ITEM)
        # ---
        APP_ENV=dev
      `,
      '.env.dev': 'BASE_ITEM=dev-val',
      '.env.prod': 'BASE_ITEM=prod-val',
      'dir/.env.schema': outdent`
        # @currentEnv=$APP_ENV2
        # ---
        APP_ENV2=prod
      `,
      'dir/.env.dev': 'IMPORTED_ITEM=dev-val',
      'dir/.env.prod': 'IMPORTED_ITEM=prod-val',
    },
    loadingError: true,
  }));
  test('currentEnv can be set from an imported file', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.imported)
        # ---
      `,
      '.env.imported': outdent`
        # @currentEnv=$IMPORTED_APP_ENV
        # ---
        IMPORTED_APP_ENV=dev
      `,
      '.env.dev': outdent`
        ITEM1=dev-value
      `,
    },
    expectValues: {
      ITEM1: 'dev-value',
    },
  }));
  test('currentEnv in an imported file will be ignored if parent already has it set', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./.env.imported)
        # ---
        APP_ENV=dev
      `,
      '.env.imported': outdent`
        # @currentEnv=$IMPORTED_APP_ENV
        # ---
        IMPORTED_APP_ENV=foo
      `,
      '.env.dev': outdent`
        ITEM1=dev-value
      `,
    },
    expectValues: {
      ITEM1: 'dev-value',
    },
  }));

  test('currentEnv will not be set from a partially imported file', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.imported, IMPORTED_ITEM)
        # ---
        ITEM1=foo
      `,
      '.env.imported': outdent`
        # @currentEnv=$IMPORTED_APP_ENV
        # ---
        IMPORTED_APP_ENV=dev
        IMPORTED_ITEM=bar
      `,
      '.env.dev': outdent`
        DEV_ITEM=dev-value
      `,
    },
    expectValues: {
      IMPORTED_ITEM: 'bar',
    },
    expectNotInSchema: ['DEV_ITEM'],
  }));

  describe('fallback env (set via cli instead of @currentEnv)', () => {
    test('fallback env value can be specified if no currentEnv is used', envFilesTest({
      fallbackEnv: 'staging',
      files: {
        '.env.schema': 'ITEM1=val-from-.env.schema',
        '.env.staging': 'ITEM1=val-from-.env.staging',
      },
      expectValues: {
        ITEM1: 'val-from-.env.staging',
      },
    }));
    test('fallback env value is ignored if currentEnv is present', envFilesTest({
      fallbackEnv: 'staging',
      files: {
        '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
        '.env.dev': 'ITEM1=val-from-.env.dev',
        '.env.staging': 'ITEM1=val-from-.env.staging',
      },
      expectValues: {
        ITEM1: 'val-from-.env.dev',
      },
    }));
  });
});

describe('multiple data-source handling', () => {
  test('undefined handling for overriding values', envFilesTest({
    files: {
      '.env.schema': outdent`
      # ---
      ITEM1=val-from-.env.schema
      ITEM2=val-from-.env.schema
    `,
      '.env': outdent`
      ITEM1=           # nothing set will not override the value
      ITEM2=undefined  # will override with undefined
    `,
    },
    expectValues: {
      ITEM1: 'val-from-.env.schema',
      ITEM2: undefined,
    },
  }));
});
