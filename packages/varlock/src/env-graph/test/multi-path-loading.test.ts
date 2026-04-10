import {
  describe, test, expect,
} from 'vitest';
import outdent from 'outdent';
import { DirectoryDataSource } from '../index';
import { envFilesTest } from './helpers/generic-test';

describe('MultiplePathsContainerDataSource', () => {
  test('loads items from two separate directories', envFilesTest({
    loadPaths: ['path1/', 'path2/'],
    files: {
      'path1/.env.schema': outdent`
        ITEM1=from-dir1
      `,
      'path2/.env.schema': outdent`
        ITEM2=from-dir2
      `,
    },
    expectValues: {
      ITEM1: 'from-dir1',
      ITEM2: 'from-dir2',
    },
  }));

  test('later path has higher precedence than earlier path', envFilesTest({
    loadPaths: ['path1/', 'path2/'],
    files: {
      'path1/.env.schema': outdent`
        SHARED_ITEM=from-dir1
      `,
      'path2/.env.schema': outdent`
        SHARED_ITEM=from-dir2
      `,
    },
    expectValues: {
      // dir2 (last path) has higher precedence
      SHARED_ITEM: 'from-dir2',
    },
  }));

  test('env-specific files are loaded per directory', envFilesTest({
    loadPaths: ['path1/', 'path2/'],
    files: {
      'path1/.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=from-dir1-schema
      `,
      'path1/.env.production': outdent`
        ITEM1=from-dir1-prod
      `,
      'path2/.env.schema': outdent`
        ITEM2=from-dir2-schema
      `,
    },
    overrideValues: { APP_ENV: 'production' },
    expectValues: {
      ITEM1: 'from-dir1-prod',
      ITEM2: 'from-dir2-schema',
    },
  }));

  test('loads items from two separate .env files (not directories)', envFilesTest({
    loadPaths: ['path1/.env.schema', 'path2/.env.schema'],
    files: {
      'path1/.env.schema': outdent`
        ITEM1=from-file1
      `,
      'path2/.env.schema': outdent`
        ITEM2=from-file2
      `,
    },
    expectValues: {
      ITEM1: 'from-file1',
      ITEM2: 'from-file2',
    },
  }));

  test('later file path has higher precedence than earlier file path', envFilesTest({
    loadPaths: ['path1/.env.schema', 'path2/.env.schema'],
    files: {
      'path1/.env.schema': outdent`
        SHARED_ITEM=from-file1
      `,
      'path2/.env.schema': outdent`
        SHARED_ITEM=from-file2
      `,
    },
    expectValues: {
      // file2 (last path) has higher precedence
      SHARED_ITEM: 'from-file2',
    },
  }));

  test('directory children of container are not env-specific, but their auto-loaded env files are', envFilesTest({
    loadPaths: ['path1/', 'path2/'],
    files: {
      'path1/.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=from-dir1-schema
      `,
      'path1/.env.production': outdent`
        ITEM1=from-dir1-prod
      `,
      'path2/.env.schema': outdent`
        ITEM2=from-dir2
      `,
    },
    overrideValues: { APP_ENV: 'production' },
    expectSerializedMatches: {
      // Just verify loading works; env-specific tests are structural
    },
  }));

  test('single path in array behaves like regular directory loading', envFilesTest({
    loadPaths: ['path1/'],
    files: {
      'path1/.env.schema': outdent`
        ITEM1=from-dir1
      `,
      'path1/.env': outdent`
        ITEM1=from-dir1-env
      `,
    },
    expectValues: {
      // .env overrides .env.schema
      ITEM1: 'from-dir1-env',
    },
  }));
});

describe('MultiplePathsContainerDataSource - isEnvSpecific behavior', () => {
  test('directory children of container are NOT env-specific', async () => {
    const { EnvGraph, MultiplePathsContainerDataSource } = await import('../index');
    const g = new EnvGraph();

    g.virtualImports = {
      '/vt/dir1/.env.schema': 'ITEM1=val1',
      '/vt/dir2/.env.schema': 'ITEM2=val2',
    };

    await g.setRootDataSource(new MultiplePathsContainerDataSource(['/vt/dir1/', '/vt/dir2/']));
    await g.finishLoad();

    const rootChildren = g.rootDataSource?.children ?? [];
    for (const child of rootChildren) {
      expect(child).toBeInstanceOf(DirectoryDataSource);
      // DirectoryDataSource children of the container are not env-specific
      expect(child.isEnvSpecific).toBe(false);
    }
  });

  test('env-specific files auto-loaded inside directory children ARE env-specific', async () => {
    const { EnvGraph, MultiplePathsContainerDataSource } = await import('../index');
    const g = new EnvGraph();

    g.virtualImports = {
      '/vt/dir1/.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val1
      `,
      '/vt/dir1/.env.production': 'ITEM1=prod-val1',
    };

    g.overrideValues = { APP_ENV: 'production' };
    await g.setRootDataSource(new MultiplePathsContainerDataSource(['/vt/dir1/']));
    await g.finishLoad();

    // Find .env.production source (it's inside dir1's children)
    const allSources = g.sortedDataSources;
    const envProdSource = allSources.find((s) => 'fileName' in s && (s as any).fileName === '.env.production');
    expect(envProdSource).toBeDefined();
    expect(envProdSource!.isEnvSpecific).toBe(true);
  });
});
