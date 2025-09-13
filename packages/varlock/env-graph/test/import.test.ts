import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

describe('@import', () => {
  test('imported file has less precedence than importing', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.import)
        # ---
        ITEM_ONLY_IN_SCHEMA=value-from-.env.schema
        ITEM_IN_BOTH=value-from-.env.schema
      `,
      '.env.import': outdent`
        ITEM_ONLY_IN_IMPORT=value-from-.env.import
        ITEM_IN_BOTH=value-from-.env.import
      `,
    },
    expectValues: {
      ITEM_ONLY_IN_SCHEMA: 'value-from-.env.schema',
      ITEM_IN_BOTH: 'value-from-.env.schema',
      ITEM_ONLY_IN_IMPORT: 'value-from-.env.import',
    },
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
    }));
  });
});
