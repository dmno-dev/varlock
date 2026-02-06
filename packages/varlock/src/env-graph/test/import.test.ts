import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

describe('@import', () => {
  test('imported file can add new items', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.import)
        # ---
        ITEM1=item1
      `,
      '.env.import': outdent`
        ITEM2=item2
      `,
    },
    expectValues: {
      ITEM1: 'item1',
      ITEM2: 'item2',
    },
  }));
  test('imported file is overridden by file that imports it', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.import)
        # ---
        ITEM1=value-from-.env.schema
      `,
      '.env.import': outdent`
        ITEM1=value-from-.env.import
      `,
    },
    expectValues: {
      ITEM1: 'value-from-.env.schema',
    },
  }));
  test('multiple imports - later import overrides earlier', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.import1)
        # @import(./.env.import2)
        # ---
      `,
      '.env.import1': outdent`
        ITEM1=value-from-.env.import1
      `,
      '.env.import2': outdent`
        ITEM1=value-from-.env.import2
      `,
    },
    expectValues: {
      ITEM1: 'value-from-.env.import2',
    },
  }));

  test('directory can be imported, which will then import .env.* files appropriately', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./dir/)
        # ---
        ITEM1=value-from-.env.schema
      `,
      'dir/.env.schema': outdent`
        ITEM1=value-from-dir/.env.schema
        ITEM2=value-from-dir/.env.schema
        ITEM3=value-from-dir/.env.schema
      `,
      'dir/.env.local': outdent`
        ITEM3=value-from-dir/.env.local
        ITEM4=value-from-dir/.env.local
      `,
    },
    expectValues: {
      ITEM1: 'value-from-.env.schema',
      ITEM2: 'value-from-dir/.env.schema',
      ITEM3: 'value-from-dir/.env.local',
      ITEM4: 'value-from-dir/.env.local',
    },
  }));

  test('error - no dynamic imports', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.$APP_ENV)
        # ---
        APP_ENV=dev
      `,
    },
    loadingError: true,
  }));

  describe('partial imports', () => {
    test('can import specific keys', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, IMPORTED1, IMPORTED2, IMPORTED3)
          # ---
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          # @import(./.env.import2)
          # ---
          IMPORTED1=value-from-.env.import
          IMPORTED2=value-from-.env.import
          SKIP1=foo
        `,
        '.env.import2': outdent`
          IMPORTED3=value-from-.env.import2
          SKIP2=foo
        `,
      },
      expectValues: {
        ITEM1: 'value-from-.env.schema',
        IMPORTED1: 'value-from-.env.import',
        IMPORTED2: 'value-from-.env.import',
        IMPORTED3: 'value-from-.env.import2',
      },
      expectNotInSchema: ['SKIP1', 'SKIP2'],
    }));
    test('key must be imported in each import', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, ITEM1)
          # ---
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          # @import(./.env.import2, ITEM1, ITEM2)
          # ---
        `,
        '.env.import2': outdent`
          ITEM1=value-from-.env.import2
          ITEM2=   # skipped because not included in all imports
        `,
      },
      expectValues: {
        ITEM1: 'value-from-.env.schema',
      },
      expectNotInSchema: ['ITEM2'],
    }));
  });

  describe('errors', () => {
    test('importing non .env.* file triggers an error', envFilesTest({
      files: {
        '.env.schema': outdent`
        # @import(./env.json)
        # ---
      `,
        'env.json': '',
      },
      loadingError: true,
    }));

    test('importing non-existant file triggers an error', envFilesTest({
      files: {
        '.env.schema': outdent`
        # @import(./.env.does-not-exist)
        # ---
      `,
      },
      loadingError: true,
    }));
  });

  describe('@import + @disable', () => {
    test('an imported file marked with @disable will be skipped', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import)
          # ---
          ITEM_ONLY_IN_SCHEMA=value-from-.env.schema
          ITEM_IN_BOTH=value-from-.env.schema
          `,
        '.env.import': outdent`
          # @disable
          # ---
          ITEM_ONLY_IN_IMPORT=value-from-.env.import
          ITEM_IN_BOTH=value-from-.env.import
        `,
      },
      expectValues: {
        ITEM_ONLY_IN_SCHEMA: 'value-from-.env.schema',
        ITEM_IN_BOTH: 'value-from-.env.schema',
      },
      expectNotInSchema: ['ITEM_ONLY_IN_IMPORT'],
    }));

    test('a file marked with @disable will also disable its imports', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import)
          # ---
          ITEM_ONLY_IN_SCHEMA=value-from-.env.schema
        `,
        '.env.import': outdent`
          # @disable
          # @import(./.env.import2)
          # ---
          ITEM_ONLY_IN_IMPORT1=value-from-.env.import1
        `,
        '.env.import2': outdent`
          ITEM_ONLY_IN_IMPORT2=value-from-.env.import2
        `,
      },
      expectValues: {
        ITEM_ONLY_IN_SCHEMA: 'value-from-.env.schema',
      },
      expectNotInSchema: ['ITEM_ONLY_IN_IMPORT1', 'ITEM_ONLY_IN_IMPORT2'],
    }));
    test('addind @disable=false in a child will not override its disabled parent', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import)
          # ---
          ITEM_ONLY_IN_SCHEMA=value-from-.env.schema
        `,
        '.env.import': outdent`
          # @disable
          # @import(./.env.import2)
          # ---
          ITEM_ONLY_IN_IMPORT1=value-from-.env.import1
        `,
        '.env.import2': outdent`
          @disable=false
          ITEM_ONLY_IN_IMPORT2=value-from-.env.import2
        `,
      },
      expectValues: {
        ITEM_ONLY_IN_SCHEMA: 'value-from-.env.schema',
      },
      expectNotInSchema: ['ITEM_ONLY_IN_IMPORT1', 'ITEM_ONLY_IN_IMPORT2'],
    }));
  });

  describe('conditional imports', () => {
    test('import with enabled=true works', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, enabled=true)
          # ---
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      expectValues: {
        ITEM1: 'value-from-.env.schema',
        ITEM2: 'value-from-.env.import',
      },
    }));

    test('import with enabled=false is skipped', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, enabled=false)
          # ---
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      expectValues: {
        ITEM1: 'value-from-.env.schema',
      },
      expectNotInSchema: ['ITEM2'],
    }));

    test('import with enabled using eq() function', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, enabled=eq($SOME_VAR, "enable"))
          # ---
          SOME_VAR=enable
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      expectValues: {
        SOME_VAR: 'enable',
        ITEM1: 'value-from-.env.schema',
        ITEM2: 'value-from-.env.import',
      },
    }));

    test('import is skipped when eq() returns false', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, enabled=eq($SOME_VAR, "enable"))
          # ---
          SOME_VAR=disable
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      expectValues: {
        SOME_VAR: 'disable',
        ITEM1: 'value-from-.env.schema',
      },
      expectNotInSchema: ['ITEM2'],
    }));

    test('import with enabled can import specific keys', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, IMPORTED1, enabled=true)
          # ---
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          IMPORTED1=value-from-.env.import
          SKIP1=foo
        `,
      },
      expectValues: {
        ITEM1: 'value-from-.env.schema',
        IMPORTED1: 'value-from-.env.import',
      },
      expectNotInSchema: ['SKIP1'],
    }));

    test('error - enabled must be a boolean', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, enabled=123)
          # ---
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      loadingError: true,
    }));

    test('multiple imports with different enabled conditions', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import1, enabled=true)
          # @import(./.env.import2, enabled=false)
          # ---
          ITEM1=value-from-.env.schema
        `,
        '.env.import1': outdent`
          ITEM2=value-from-.env.import1
        `,
        '.env.import2': outdent`
          ITEM3=value-from-.env.import2
        `,
      },
      expectValues: {
        ITEM1: 'value-from-.env.schema',
        ITEM2: 'value-from-.env.import1',
      },
      expectNotInSchema: ['ITEM3'],
    }));

    test('enabled with not() function', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, enabled=not(eq($SOME_VAR, "disable")))
          # ---
          SOME_VAR=enable
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      expectValues: {
        SOME_VAR: 'enable',
        ITEM1: 'value-from-.env.schema',
        ITEM2: 'value-from-.env.import',
      },
    }));

    test('enabled with forEnv() function', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @currentEnv=$APP_ENV
          # @import(./.env.import, enabled=forEnv("dev"))
          # ---
          APP_ENV=dev
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      expectValues: {
        APP_ENV: 'dev',
        ITEM1: 'value-from-.env.schema',
        ITEM2: 'value-from-.env.import',
      },
    }));

    test('import is skipped when forEnv() returns false', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @currentEnv=$APP_ENV
          # @import(./.env.import, enabled=forEnv("production"))
          # ---
          APP_ENV=dev
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      expectValues: {
        APP_ENV: 'dev',
        ITEM1: 'value-from-.env.schema',
      },
      expectNotInSchema: ['ITEM2'],
    }));
  });
});
