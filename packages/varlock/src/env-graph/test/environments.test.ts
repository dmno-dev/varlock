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
    expectError: true,
  }));

  // #428: @currentEnv may reference a flag key brought in via @import
  test('@currentEnv can reference a key imported via pick=[]', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(./.env.shared, pick=[DEPLOY_ENV])
        # ---
      `,
      '.env.shared': outdent`
        # ---
        DEPLOY_ENV=dev
      `,
      '.env.dev': outdent`
        ITEM1=from-dev
      `,
    },
    expectValues: {
      DEPLOY_ENV: 'dev',
      ITEM1: 'from-dev',
    },
  }));

  test('@currentEnv can reference a key imported via pick glob', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(./.env.shared, pick=[DEPLOY_*])
        # ---
      `,
      '.env.shared': outdent`
        # ---
        DEPLOY_ENV=staging
        DEPLOY_REGION=us
      `,
      '.env.staging': outdent`
        ITEM1=from-staging
      `,
    },
    expectValues: {
      DEPLOY_ENV: 'staging',
      DEPLOY_REGION: 'us',
      ITEM1: 'from-staging',
    },
  }));

  test('@currentEnv can reference a key imported via deprecated positional keys', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(./.env.shared, DEPLOY_ENV)
        # ---
      `,
      '.env.shared': outdent`
        # ---
        DEPLOY_ENV=dev
      `,
      '.env.dev': outdent`
        ITEM1=from-dev-positional
      `,
    },
    expectValues: {
      DEPLOY_ENV: 'dev',
      ITEM1: 'from-dev-positional',
    },
  }));

  test('@currentEnv errors when imported pick list omits the flag key', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(./.env.shared, pick=[OTHER])
        # ---
      `,
      '.env.shared': outdent`
        # ---
        DEPLOY_ENV=dev
        OTHER=x
      `,
    },
    expectError: true,
  }));

  // A dynamic enabled=false import must not let a values-only .env key act as @currentEnv
  test('@currentEnv errors when a dynamic import is disabled even if .env has the flag', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(./.env.shared, enabled=eq($ENABLE, "yes"), pick=[DEPLOY_ENV])
        # ---
        ENABLE=no
      `,
      '.env.shared': outdent`
        # ---
        DEPLOY_ENV=staging
      `,
      '.env': 'DEPLOY_ENV=dev',
      '.env.dev': 'ITEM1=should-not-load',
    },
    expectError: true,
  }));

  test('@currentEnv can use a dynamically enabled import even if .env also has the flag', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(./.env.shared, enabled=eq($ENABLE, "yes"), pick=[DEPLOY_ENV])
        # ---
        ENABLE=yes
      `,
      '.env.shared': outdent`
        # ---
        DEPLOY_ENV=staging
      `,
      '.env': 'DEPLOY_ENV=dev',
      '.env.dev': 'ITEM1=from-dev',
    },
    expectValues: {
      DEPLOY_ENV: 'dev',
      ITEM1: 'from-dev',
    },
  }));

  test('imported directory loads .env.<env> when the flag import is declared before it', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(./.env.shared, pick=[DEPLOY_ENV])
        # @import(./service/)
        # ---
      `,
      '.env.shared': outdent`
        # ---
        DEPLOY_ENV=dev
      `,
      'service/.env.dev': 'SERVICE_ITEM=from-dev',
      'service/.env.prod': 'SERVICE_ITEM=from-prod',
    },
    expectValues: {
      DEPLOY_ENV: 'dev',
      SERVICE_ITEM: 'from-dev',
    },
  }));

  test('directory import declared before the flag import is an error', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(./service/)
        # @import(./.env.shared, pick=[DEPLOY_ENV])
        # ---
      `,
      '.env.shared': outdent`
        # ---
        DEPLOY_ENV=dev
      `,
      'service/.env.dev': 'SERVICE_ITEM=from-dev',
    },
    expectError: true,
  }));

  test('ancestor currentEnv does not cross a nested directory with its own currentEnv', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(./.env.shared, pick=[DEPLOY_ENV])
        # @import(./service/)
        # ---
      `,
      '.env.shared': outdent`
        # ---
        DEPLOY_ENV=dev
      `,
      'service/.env.schema': outdent`
        # @currentEnv=$SERVICE_ENV
        # @import(./nested/)
        # ---
        SERVICE_ENV=prod
      `,
      'service/.env.dev': 'SERVICE_ITEM=service-dev',
      'service/.env.prod': 'SERVICE_ITEM=service-prod',
      'service/nested/.env.dev': 'NESTED_ITEM=nested-dev',
      'service/nested/.env.prod': 'NESTED_ITEM=nested-prod',
    },
    expectValues: {
      DEPLOY_ENV: 'dev',
      SERVICE_ENV: 'prod',
      SERVICE_ITEM: 'service-prod',
      NESTED_ITEM: 'nested-prod',
    },
  }));

  // the deferred check is scoped to this file's own imports: a declaration that reached the
  // graph another way must not satisfy it, or an omitted pick entry would go unreported
  test('@currentEnv pending on an unrelated import errors even when another load path declares the flag', envFilesTest({
    files: {
      'a/.env.schema': outdent`
        # @currentEnv=$FLAG
        # ---
        FLAG=dev
      `,
      'b/.env.schema': outdent`
        # @currentEnv=$FLAG
        # @import(./.env.other, pick=[OTHER])
        # ---
      `,
      'b/.env.other': 'OTHER=1\nFLAG=prod',
      'b/.env.dev': 'B=dev',
    },
    loadPaths: ['a/', 'b/'],
    expectError: true,
  }));

  test('@currentEnv pending on an unrelated import errors even when an ancestor schema declares the flag', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$FLAG
        # @import(./child/)
        # ---
        FLAG=dev
      `,
      'child/.env.schema': outdent`
        # @currentEnv=$FLAG
        # @import(./.env.other, pick=[OTHER])
        # ---
      `,
      'child/.env.other': 'OTHER=1',
      'child/.env.dev': 'C=dev',
    },
    expectError: true,
  }));

  test('@currentEnv satisfied through a diamond import alias', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./a/)
        # @import(./b/)
        # ---
      `,
      '.env.shared': 'DEPLOY_ENV=dev',
      'a/.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(../.env.shared, pick=[DEPLOY_ENV])
        # ---
      `,
      'a/.env.dev': 'A_ITEM=a-dev',
      'b/.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(../.env.shared, pick=[DEPLOY_ENV])
        # ---
      `,
      'b/.env.dev': 'B_ITEM=b-dev',
    },
    expectValues: { DEPLOY_ENV: 'dev', A_ITEM: 'a-dev', B_ITEM: 'b-dev' },
  }));

  test('@currentEnv is not satisfied by a diamond alias whose original source is disabled', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.shared, pick=[OTHER])
        # @import(./b/)
        # ---
      `,
      '.env.shared': outdent`
        # @disable=true
        # ---
        DEPLOY_ENV=dev
        OTHER=1
      `,
      'b/.env.schema': outdent`
        # @currentEnv=$DEPLOY_ENV
        # @import(../.env.shared, pick=[DEPLOY_ENV])
        # ---
      `,
      'b/.env.dev': 'B=dev',
    },
    expectError: true,
  }));

  // @currentEnv itself can live in the imported file, and propagates through a partial
  // import as long as the flag item passes the import filter
  test('imported @currentEnv propagates through a partial import that includes the flag', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./shared/.env.schema, pick=[APP_ENV])
        # ---
        X=
      `,
      'shared/.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        SHARED_X=1
      `,
      '.env.dev': 'X=from-dev',
    },
    expectValues: { APP_ENV: 'dev', X: 'from-dev' },
    expectNotInSchema: ['SHARED_X'],
  }));

  test('imported @currentEnv via partial import wins over the --env fallback', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./shared/.env.schema, pick=[APP_ENV])
        # ---
        X=
      `,
      'shared/.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
      `,
      '.env.dev': 'X=from-dev',
      '.env.prod': 'X=from-prod',
    },
    fallbackEnv: 'prod',
    expectValues: { APP_ENV: 'dev', X: 'from-dev' },
  }));

  test('imported @currentEnv does not propagate when the partial import excludes the flag', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./shared/.env.schema, pick=[SHARED_X])
        # ---
        X=
      `,
      'shared/.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        SHARED_X=1
      `,
      '.env.dev': 'X=from-dev',
    },
    expectValues: { X: undefined, SHARED_X: 1 },
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
    expectError: true,
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
    expectError: true,
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
  test('currentEnv set from an imported file - env-specific files can have their own imports', envFilesTest({
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
        # @import(./.env.dev-extras)
        # ---
        ITEM1=dev-value
      `,
      '.env.dev-extras': outdent`
        ITEM2=dev-extras-value
      `,
    },
    expectValues: {
      ITEM1: 'dev-value',
      ITEM2: 'dev-extras-value',
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

    // The importing directory has no @currentEnv of its own — it inherits one from the
    // imported schema. That resolves only AFTER imports are processed, so a fallback
    // must not be treated as the final answer before then.
    test('fallback env value is ignored if currentEnv comes from an import', envFilesTest({
      fallbackEnv: 'staging',
      files: {
        '.env.schema': outdent`
        # @import(./shared/)
        # ---
        ITEM1=val-from-.env.schema
      `,
        'shared/.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
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
