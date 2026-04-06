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
          # @import(
          #   ./.env.import,
          #   IMPORTED1,
          #   IMPORTED2,
          #   IMPORTED3
          # )
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
    test('import with enabled using static value', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import1, enabled=true)
          # @import(./.env.import2, enabled=false)
          # ---
        `,
        '.env.import1': outdent`
          IMPORT1_ITEM=value-from-.env.import
        `,
        '.env.import2': outdent`
          IMPORT2_ITEM=value-from-.env.import
        `,
      },
      expectValues: {
        IMPORT1_ITEM: 'value-from-.env.import',
      },
      expectNotInSchema: ['IMPORT2_ITEM'],
    }));
    test('import with enabled using function', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import1, enabled=eq($SOME_VAR, "enable"))
          # @import(./.env.import2, enabled=eq($SOME_VAR, "disable"))
          # ---
          SOME_VAR=enable
        `,
        '.env.import1': outdent`
          IMPORT1_ITEM=value-from-.env.import
        `,
        '.env.import2': outdent`
          IMPORT2_ITEM=value-from-.env.import
        `,
      },
      expectValues: {
        IMPORT1_ITEM: 'value-from-.env.import',
      },
      expectNotInSchema: ['IMPORT2_ITEM'],
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
    test('error - bad reference', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, enabled=$BADKEY)
          # ---
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      loadingError: true,
    }));

    // forEnv has special handling, so good to test
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
  });

  describe('allowMissing flag', () => {
    test('allowMissing=true with non-existent file does not error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.does-not-exist, allowMissing=true)
          # ---
          ITEM1=value-from-.env.schema
        `,
      },
      expectValues: {
        ITEM1: 'value-from-.env.schema',
      },
    }));

    test('allowMissing=false with non-existent file errors', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.does-not-exist, allowMissing=false)
          # ---
          ITEM1=value-from-.env.schema
        `,
      },
      loadingError: true,
    }));

    test('allowMissing=true with existing file imports normally', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, allowMissing=true)
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

    test('allowMissing=true with non-existent directory does not error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./missing-dir/, allowMissing=true)
          # ---
          ITEM1=value-from-.env.schema
        `,
      },
      expectValues: {
        ITEM1: 'value-from-.env.schema',
      },
    }));

    test('allowMissing can be combined with enabled flag', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.does-not-exist, allowMissing=true, enabled=true)
          # ---
          ITEM1=value-from-.env.schema
        `,
      },
      expectValues: {
        ITEM1: 'value-from-.env.schema',
      },
    }));

    test('allowMissing with enabled=false still skips import', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, allowMissing=true, enabled=false)
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

    test('allowMissing with non-boolean value errors', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, allowMissing="yes")
          # ---
          ITEM1=value-from-.env.schema
        `,
        '.env.import': outdent`
          ITEM2=value-from-.env.import
        `,
      },
      loadingError: true,
    }));
  });

  describe('diamond dependency (same schema imported via multiple paths)', () => {
    test('directory imported twice via different paths does not error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./root/, ROOT_VAR)
          # @import(./shared/)
          # ---
        `,
        'root/.env.schema': outdent`
          ROOT_VAR=root-value
          OTHER_VAR=other-value
        `,
        'shared/.env.schema': outdent`
          # @import(../root/, ROOT_VAR)
          # ---
          SHARED_VAR=shared-value
        `,
      },
      expectValues: {
        ROOT_VAR: 'root-value',
        SHARED_VAR: 'shared-value',
      },
    }));

    test('directory with plugin @init imported twice via different paths does not error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./root/, ROOT_VAR)
          # @import(./shared/)
          # ---
        `,
        'root/.env.schema': outdent`
          # @plugin(../plugins/test-plugin-with-init/)
          # @initTestPlugin()
          # ---
          ROOT_VAR=root-value
        `,
        'shared/.env.schema': outdent`
          # @import(../root/, ROOT_VAR)
          # ---
          SHARED_VAR=shared-value
        `,
      },
      expectValues: {
        ROOT_VAR: 'root-value',
        SHARED_VAR: 'shared-value',
      },
    }));

    test('file imported twice via different paths does not error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.common)
          # @import(./.env.layer)
          # ---
        `,
        '.env.common': outdent`
          COMMON_VAR=common-value
        `,
        '.env.layer': outdent`
          # @import(./.env.common)
          # ---
          LAYER_VAR=layer-value
        `,
      },
      expectValues: {
        COMMON_VAR: 'common-value',
        LAYER_VAR: 'layer-value',
      },
    }));

    test('different importKeys subsets - both subsets accessible', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.common, A)
          # @import(./.env.layer)
          # ---
        `,
        '.env.common': outdent`
          A=val-a
          B=val-b
        `,
        '.env.layer': outdent`
          # @import(./.env.common, B)
          # ---
          LAYER=layer-val
        `,
      },
      expectValues: {
        A: 'val-a',
        B: 'val-b',
        LAYER: 'layer-val',
      },
    }));

    test('first partial, second full - all items accessible', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.common, A)
          # @import(./.env.layer)
          # ---
        `,
        '.env.common': outdent`
          A=val-a
          B=val-b
          C=val-c
        `,
        '.env.layer': outdent`
          # @import(./.env.common)
          # ---
          LAYER=layer-val
        `,
      },
      expectValues: {
        A: 'val-a',
        B: 'val-b',
        C: 'val-c',
        LAYER: 'layer-val',
      },
    }));

    test('first full, second partial - all items accessible', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.common)
          # @import(./.env.layer)
          # ---
        `,
        '.env.common': outdent`
          A=val-a
          B=val-b
          C=val-c
        `,
        '.env.layer': outdent`
          # @import(./.env.common, B)
          # ---
          LAYER=layer-val
        `,
      },
      expectValues: {
        A: 'val-a',
        B: 'val-b',
        C: 'val-c',
        LAYER: 'layer-val',
      },
    }));

    test('overlapping importKeys subsets', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.common, A, B)
          # @import(./.env.layer)
          # ---
        `,
        '.env.common': outdent`
          A=val-a
          B=val-b
          C=val-c
        `,
        '.env.layer': outdent`
          # @import(./.env.common, B, C)
          # ---
          LAYER=layer-val
        `,
      },
      expectValues: {
        A: 'val-a',
        B: 'val-b',
        C: 'val-c',
        LAYER: 'layer-val',
      },
    }));

    test('plugin @init imported twice - different importKeys still only inits plugin once', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.common, ROOT_A)
          # @import(./.env.layer)
          # ---
        `,
        '.env.common': outdent`
          # @plugin(./plugins/test-plugin-with-init/)
          # @initTestPlugin()
          # ---
          ROOT_A=root-a-value
          ROOT_B=root-b-value
        `,
        '.env.layer': outdent`
          # @import(./.env.common, ROOT_B)
          # ---
          LAYER_VAR=layer-value
        `,
      },
      expectValues: {
        ROOT_A: 'root-a-value',
        ROOT_B: 'root-b-value',
        LAYER_VAR: 'layer-value',
      },
    }));

    test('items not in any importKeys subset are excluded', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.common, A)
          # @import(./.env.layer)
          # ---
        `,
        '.env.common': outdent`
          A=val-a
          B=val-b
          UNREQUESTED=should-not-appear
        `,
        '.env.layer': outdent`
          # @import(./.env.common, B)
          # ---
          LAYER=layer-val
        `,
      },
      expectValues: {
        A: 'val-a',
        B: 'val-b',
        LAYER: 'layer-val',
      },
      expectNotInSchema: ['UNREQUESTED'],
    }));

    // Precedence tests: verify that diamond deduplication doesn't break override ordering
    test('second importer overrides imported item value', envFilesTest({
      // .env.layer imports .env.common (deduplicated) AND defines its own B
      // layer's B should override common's B since the importer has higher priority
      files: {
        '.env.schema': outdent`
          # @import(./.env.common, A)
          # @import(./.env.layer)
          # ---
        `,
        '.env.common': outdent`
          A=common-a
          B=common-b
        `,
        '.env.layer': outdent`
          # @import(./.env.common, B)
          # ---
          B=layer-b
        `,
      },
      expectValues: {
        A: 'common-a',
        B: 'layer-b',
      },
    }));

    test('re-import respects precedence', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import)
          # @import(./.env.import2)
          # ---
        `,
        '.env.import': outdent`
          # @import(./.env.common)
          # ---
          A=import-a
        `,
        '.env.import2': outdent`
          # @import(./.env.common)
        `,
        '.env.common': outdent`
          A=common-a
        `,
      },
      expectValues: {
        A: 'common-a',
      },
    }));


    test('main schema overrides item from deduplicated import', envFilesTest({
      // main defines A itself and also imports .env.common (which has A)
      // main's definition should win since it has highest priority
      files: {
        '.env.schema': outdent`
          # @import(./.env.common)
          # @import(./.env.layer)
          # ---
          A=main-a
        `,
        '.env.common': outdent`
          A=common-a
          B=common-b
        `,
        '.env.layer': outdent`
          # @import(./.env.common, B)
          # ---
          LAYER=layer-val
        `,
      },
      expectValues: {
        A: 'main-a',
        B: 'common-b',
        LAYER: 'layer-val',
      },
    }));

    test('later import of same key still gets correct value', envFilesTest({
      // Both importers request the same key A from .env.common
      // common's value should be used since neither importer overrides it
      files: {
        '.env.schema': outdent`
          # @import(./.env.layer1)
          # @import(./.env.layer2)
          # ---
        `,
        '.env.common': outdent`
          A=common-a
        `,
        '.env.layer1': outdent`
          # @import(./.env.common, A)
          # ---
          S1=layer1-val
        `,
        '.env.layer2': outdent`
          # @import(./.env.common, A)
          # ---
          S2=layer2-val
        `,
      },
      expectValues: {
        A: 'common-a',
        S1: 'layer1-val',
        S2: 'layer2-val',
      },
    }));

    test('override chain: re-import at higher position promotes common over earlier override', envFilesTest({
      // overlay (higher priority) re-imports common, so common's Y appears at overlay's
      // position — above base's Y=base-y override. This matches non-deduplicated behavior:
      // overlay's copy of common would shadow base's definitions.
      files: {
        '.env.schema': outdent`
          # @import(./.env.base)
          # @import(./.env.overlay)
          # ---
          X=main-x
        `,
        '.env.common': outdent`
          X=common-x
          Y=common-y
          Z=common-z
        `,
        '.env.base': outdent`
          # @import(./.env.common)
          # ---
          Y=base-y
        `,
        '.env.overlay': outdent`
          # @import(./.env.common)
          # ---
          Z=overlay-z
        `,
      },
      expectValues: {
        X: 'main-x',
        Y: 'common-y', // common via overlay (higher priority) beats base's override
        Z: 'overlay-z', // overlay's own definition beats its import of common
      },
    }));
  });
});
