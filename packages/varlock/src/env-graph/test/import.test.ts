import {
  describe, test, expect, vi,
} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import outdent from 'outdent';
import { EnvGraph, DirectoryDataSource, LoadingError } from '../index';
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
    expectError: true,
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

  describe('pick / omit filters', () => {
    test.each([
      ['pick', 'pick=[FOO]'],
      ['omit', 'omit=[BAR]'],
    ])('%s filters keys from real filesystem directory imports', async (_filterName, filterArg) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varlock-directory-import-filter-'));
      const appDir = path.join(tempDir, 'app');
      const sharedDir = path.join(tempDir, 'shared');

      try {
        await fs.mkdir(appDir);
        await fs.mkdir(sharedDir);
        await fs.writeFile(path.join(appDir, '.env.schema'), `# @import(../shared/, ${filterArg})\n# ---\n`);
        await fs.writeFile(path.join(sharedDir, '.env.schema'), 'FOO=foo\nBAR=bar\n');

        const g = new EnvGraph();
        await g.setRootDataSource(new DirectoryDataSource(appDir));
        await g.finishLoad();

        expect(g.sortedDataSources.flatMap((source) => source.errors).filter((error) => !error.isWarning)).toEqual([]);
        expect(Object.keys(g.configSchema)).toEqual(['FOO']);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test('pick=[...] only imports listed keys', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[IMPORTED1, IMPORTED2])
          # ---
        `,
        '.env.import': outdent`
          IMPORTED1=a
          IMPORTED2=b
          SKIP=c
        `,
      },
      expectValues: { IMPORTED1: 'a', IMPORTED2: 'b' },
      expectNotInSchema: ['SKIP'],
    }));

    test('omit=[...] imports everything except listed keys', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, omit=[SECRET])
          # ---
        `,
        '.env.import': outdent`
          IMPORTED1=a
          IMPORTED2=b
          SECRET=c
        `,
      },
      expectValues: { IMPORTED1: 'a', IMPORTED2: 'b' },
      expectNotInSchema: ['SECRET'],
    }));

    test('pick supports globs', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[API_*])
          # ---
        `,
        '.env.import': outdent`
          API_KEY=a
          API_URL=b
          DB_HOST=c
        `,
      },
      expectValues: { API_KEY: 'a', API_URL: 'b' },
      expectNotInSchema: ['DB_HOST'],
    }));

    test('omit supports globs', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, omit=[DEBUG_*])
          # ---
        `,
        '.env.import': outdent`
          API_KEY=a
          DEBUG_A=b
          DEBUG_B=c
        `,
      },
      expectValues: { API_KEY: 'a' },
      expectNotInSchema: ['DEBUG_A', 'DEBUG_B'],
    }));

    test('pick intersects across nested imports', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[ITEM1])
          # ---
        `,
        '.env.import': outdent`
          # @import(./.env.import2, pick=[ITEM1, ITEM2])
          # ---
        `,
        '.env.import2': outdent`
          ITEM1=a
          ITEM2=b
        `,
      },
      expectValues: { ITEM1: 'a' },
      expectNotInSchema: ['ITEM2'],
    }));

    test('deprecated positional keys still work', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, IMPORTED1)
          # ---
        `,
        '.env.import': outdent`
          IMPORTED1=a
          SKIP=b
        `,
      },
      expectValues: { IMPORTED1: 'a' },
      expectNotInSchema: ['SKIP'],
    }));

    test('deprecated positional keys match literally (no globs or selectors)', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, PLAIN, API_*, !SECRET, #frontend)
          # ---
        `,
        '.env.import': outdent`
          PLAIN=p
          API_KEY=a
          SECRET=s
          # @tag(frontend)
          PUBLIC_URL=u
        `,
      },
      // PLAIN proves the import ran; the other args are literal key names that match nothing
      expectValues: { PLAIN: 'p' },
      expectNotInSchema: ['API_KEY', 'SECRET', 'PUBLIC_URL'],
    }));

    test('using both pick and omit is an error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[A], omit=[B])
          # ---
        `,
        '.env.import': 'A=1\nB=2',
      },
      expectError: true,
    }));

    test('combining positional keys with pick is an error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, A, pick=[B])
          # ---
        `,
        '.env.import': 'A=1\nB=2',
      },
      expectError: true,
    }));

    test('non-array pick is an error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=A)
          # ---
        `,
        '.env.import': 'A=1',
      },
      expectError: true,
    }));
  });

  describe('pick / omit selectors (tags + negation)', () => {
    test('pick=[#tag] imports only items tagged in the imported file', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[#frontend])
          # ---
        `,
        '.env.import': outdent`
          # @tag(frontend)
          PUBLIC_URL=https://example.com
          # @tag(backend)
          DATABASE_URL=postgres://x
          # @tag(frontend, backend)
          SHARED=both
          UNTAGGED=x
        `,
      },
      expectValues: { PUBLIC_URL: 'https://example.com', SHARED: 'both' },
      expectTags: { PUBLIC_URL: ['frontend'], SHARED: ['frontend', 'backend'] },
      expectNotInSchema: ['DATABASE_URL', 'UNTAGGED'],
    }));

    test('omit=[#tag] imports everything except tagged items', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, omit=[#backend])
          # ---
        `,
        '.env.import': outdent`
          # @tag(frontend)
          PUBLIC_URL=https://example.com
          # @tag(backend)
          DATABASE_URL=postgres://x
          UNTAGGED=x
        `,
      },
      expectValues: { PUBLIC_URL: 'https://example.com', UNTAGGED: 'x' },
      expectNotInSchema: ['DATABASE_URL'],
    }));

    test('tags and key names/globs combine as a union', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[#frontend, APP_*, DATABASE_URL])
          # ---
        `,
        '.env.import': outdent`
          # @tag(frontend)
          PUBLIC_URL=https://example.com
          APP_NAME=demo
          DATABASE_URL=postgres://x
          SECRET=x
        `,
      },
      expectValues: { PUBLIC_URL: 'https://example.com', APP_NAME: 'demo', DATABASE_URL: 'postgres://x' },
      expectNotInSchema: ['SECRET'],
    }));

    test('!negation narrows a pick', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[API_*, !API_SECRET])
          # ---
        `,
        '.env.import': outdent`
          API_URL=u
          API_KEY=k
          API_SECRET=s
          OTHER=o
        `,
      },
      expectValues: { API_URL: 'u', API_KEY: 'k' },
      expectNotInSchema: ['API_SECRET', 'OTHER'],
    }));

    test('!#tag negation excludes tagged items from a pick', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[#frontend, !#internal])
          # ---
        `,
        '.env.import': outdent`
          # @tag(frontend)
          PUBLIC_URL=u
          # @tag(frontend, internal)
          PUBLIC_DEBUG=d
        `,
      },
      expectValues: { PUBLIC_URL: 'u' },
      expectNotInSchema: ['PUBLIC_DEBUG'],
    }));

    test('a tag on the schema definition lets the directory\'s value files through too', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./shared/, pick=[#frontend])
          # ---
        `,
        'shared/.env.schema': outdent`
          # @tag(frontend)
          PUBLIC_URL=
          # @tag(backend)
          DATABASE_URL=
        `,
        'shared/.env': outdent`
          PUBLIC_URL=from-env-file
          DATABASE_URL=from-env-file
        `,
      },
      expectValues: { PUBLIC_URL: 'from-env-file' },
      expectNotInSchema: ['DATABASE_URL'],
    }));

    test('#tag pick sees tags declared deeper in the imported subtree', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.mid, pick=[#frontend])
          # ---
        `,
        '.env.mid': outdent`
          # @import(./.env.leaf)
          # ---
          # @tag(frontend)
          MID_ITEM=mid
          MID_OTHER=x
        `,
        '.env.leaf': outdent`
          # @tag(frontend)
          LEAF_ITEM=leaf
          LEAF_OTHER=x
        `,
      },
      expectValues: { MID_ITEM: 'mid', LEAF_ITEM: 'leaf' },
      expectNotInSchema: ['MID_OTHER', 'LEAF_OTHER'],
    }));

    test('#tag filters intersect with key filters across nested imports', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.mid, pick=[#frontend])
          # ---
        `,
        '.env.mid': outdent`
          # @import(./.env.leaf, pick=[A, B])
          # ---
        `,
        '.env.leaf': outdent`
          # @tag(frontend)
          A=a
          B=b
          # @tag(frontend)
          C=c
        `,
      },
      expectValues: { A: 'a' },
      expectNotInSchema: ['B', 'C'],
    }));

    test('the same source imported twice with different #tag picks (diamond)', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./root/, pick=[#a])
          # @import(./shared/)
          # ---
        `,
        'root/.env.schema': outdent`
          # @tag(a)
          A_ITEM=a
          # @tag(b)
          B_ITEM=b
          C_ITEM=c
        `,
        'shared/.env.schema': outdent`
          # @import(../root/, pick=[#b])
          # ---
          SHARED_VAR=shared
        `,
      },
      expectValues: { A_ITEM: 'a', B_ITEM: 'b', SHARED_VAR: 'shared' },
      expectNotInSchema: ['C_ITEM'],
    }));

    test('a tag on a disabled definition does not let an untagged active one through', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./shared/, pick=[#frontend])
          # ---
        `,
        'shared/.env.schema': outdent`
          # @disable
          # ---
          # @tag(frontend)
          KEY=
        `,
        'shared/.env': outdent`
          KEY=from-env-file
        `,
      },
      expectNotInSchema: ['KEY'],
    }));

    test('a tag hidden by an inner import filter does not count for the outer #tag pick', envFilesTest({
      files: {
        // KEY is declared here (no value), so the imported definitions decide its value
        '.env.schema': outdent`
          # @import(./.env.mid, pick=[#frontend])
          # ---
          KEY=
        `,
        '.env.mid': outdent`
          # @import(./.env.leaf, pick=[OTHER])
          # ---
          KEY=mid-untagged
        `,
        '.env.leaf': outdent`
          # @tag(frontend)
          KEY=leaf-tagged
          # @tag(frontend)
          OTHER=other
        `,
      },
      // leaf's tag is hidden by the inner pick, so mid's untagged KEY must not be imported
      expectValues: { KEY: undefined, OTHER: 'other' },
    }));

    test('@currentEnv flag can be brought in via a #tag pick', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[#env])
          # @currentEnv=$APP_ENV
          # ---
        `,
        '.env.import': outdent`
          # @tag(env)
          APP_ENV=production
          OTHER=x
        `,
        '.env.production': outdent`
          FROM_ENV_FILE=prod
        `,
      },
      expectValues: { APP_ENV: 'production', FROM_ENV_FILE: 'prod' },
      expectNotInSchema: ['OTHER'],
    }));

    test('decorator selectors are not supported in pick', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[@sensitive])
          # ---
        `,
        '.env.import': 'A=1',
      },
      expectError: true,
    }));

    test('an empty tag selector is an error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(./.env.import, pick=[#])
          # ---
        `,
        '.env.import': 'A=1',
      },
      expectError: true,
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
      expectError: true,
    }));

    test('importing non-existant file triggers an error', envFilesTest({
      files: {
        '.env.schema': outdent`
        # @import(./.env.does-not-exist)
        # ---
      `,
      },
      expectError: true,
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
      expectError: true,
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
      expectError: true,
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
      expectError: true,
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
      expectError: true,
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

  describe('circular imports', () => {
    // a 2-node cycle (a -> b -> a) must fail with a clean error rather than
    // recursing until the call stack overflows
    test('2-node cycle fails cleanly', envFilesTest({
      files: {
        'a/.env.schema': outdent`
          # @import(../b/)
          # ---
          A_VAR=1
        `,
        'b/.env.schema': outdent`
          # @import(../a/)
          # ---
          B_VAR=2
        `,
      },
      loadPaths: 'a/',
      expectError: LoadingError,
    }));

    // a 3-node cycle (a -> b -> c -> a) must also fail cleanly
    test('3-node cycle fails cleanly', envFilesTest({
      files: {
        'a/.env.schema': outdent`
          # @import(../b/)
          # ---
          A_VAR=1
        `,
        'b/.env.schema': outdent`
          # @import(../c/)
          # ---
          B_VAR=2
        `,
        'c/.env.schema': outdent`
          # @import(../a/)
          # ---
          C_VAR=3
        `,
      },
      loadPaths: 'a/',
      expectError: LoadingError,
    }));

    // the error message should spell out the import chain that loops back
    test('reports the import chain in the error message', async () => {
      const currentDir = path.dirname(expect.getState().testPath!);
      vi.spyOn(process, 'cwd').mockReturnValue(currentDir);

      const g = new EnvGraph();
      g.setVirtualImports(currentDir, {
        'a/.env.schema': '# @import(../b/)\n# ---\nA_VAR=1\n',
        'b/.env.schema': '# @import(../a/)\n# ---\nB_VAR=2\n',
      });
      await g.setRootDataSource(new DirectoryDataSource(`${path.resolve(currentDir, 'a')}${path.sep}`));
      await g.finishLoad();

      const cycleError = g.sortedDataSources
        .flatMap((s) => s.errors)
        .find((e) => e.message.includes('Circular import detected'));
      expect(cycleError).toBeInstanceOf(LoadingError);
      expect(cycleError!.message).toBe(
        'Circular import detected: a/.env.schema -> b/.env.schema -> a/.env.schema',
      );
    });
  });
});
