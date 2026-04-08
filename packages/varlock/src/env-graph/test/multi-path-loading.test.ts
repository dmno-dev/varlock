import {
  describe, test, expect,
} from 'vitest';
import path from 'node:path';
import outdent from 'outdent';
import { EnvGraph, MultiplePathsContainerDataSource } from '../index';

/**
 * Helper to create a graph with multiple virtual directories.
 * Each key in the `dirs` map is a directory path (should end with path.sep),
 * and its value is a Record of filename → content.
 */
async function multiDirTest(spec: {
  dirs: Record<string, Record<string, string>>;
  overrideValues?: Record<string, string>;
  fallbackEnv?: string;
}) {
  const g = new EnvGraph();

  g.virtualImports = {};
  for (const [dirPath, files] of Object.entries(spec.dirs)) {
    for (const [fileName, content] of Object.entries(files)) {
      g.virtualImports[path.join(dirPath, fileName)] = content;
    }
  }

  if (spec.overrideValues) g.overrideValues = spec.overrideValues;
  if (spec.fallbackEnv) g.envFlagFallback = spec.fallbackEnv;

  // Ensure paths end with sep so MultiplePathsContainerDataSource treats them as directories
  const paths = Object.keys(spec.dirs).map((p) => (p.endsWith(path.sep) ? p : p + path.sep));
  await g.setRootDataSource(new MultiplePathsContainerDataSource(paths));
  await g.finishLoad();

  return g;
}

describe('MultiplePathsContainerDataSource', () => {
  test('loads items from two separate directories', async () => {
    const g = await multiDirTest({
      dirs: {
        '/tmp/varlock-test/dir1/': {
          '.env.schema': outdent`
            ITEM1=from-dir1
          `,
        },
        '/tmp/varlock-test/dir2/': {
          '.env.schema': outdent`
            ITEM2=from-dir2
          `,
        },
      },
    });

    await g.resolveEnvValues();

    expect(g.configSchema.ITEM1?.resolvedValue).toBe('from-dir1');
    expect(g.configSchema.ITEM2?.resolvedValue).toBe('from-dir2');
    expect(Object.keys(g.configSchema)).not.toContain('ITEM3');
  });

  test('later path has higher precedence than earlier path', async () => {
    const g = await multiDirTest({
      dirs: {
        '/tmp/varlock-test/dir1/': {
          '.env.schema': outdent`
            SHARED_ITEM=from-dir1
          `,
        },
        '/tmp/varlock-test/dir2/': {
          '.env.schema': outdent`
            SHARED_ITEM=from-dir2
          `,
        },
      },
    });

    await g.resolveEnvValues();

    // dir2 (last path) has higher precedence
    expect(g.configSchema.SHARED_ITEM?.resolvedValue).toBe('from-dir2');
  });

  test('env-specific files are loaded per directory', async () => {
    const g = await multiDirTest({
      dirs: {
        '/tmp/varlock-test/dir1/': {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV
            # ---
            APP_ENV=dev
            ITEM1=from-dir1-schema
          `,
          '.env.production': outdent`
            ITEM1=from-dir1-prod
          `,
        },
        '/tmp/varlock-test/dir2/': {
          '.env.schema': outdent`
            ITEM2=from-dir2-schema
          `,
        },
      },
      overrideValues: { APP_ENV: 'production' },
    });

    await g.resolveEnvValues();

    expect(g.configSchema.ITEM1?.resolvedValue).toBe('from-dir1-prod');
    expect(g.configSchema.ITEM2?.resolvedValue).toBe('from-dir2-schema');
  });

  test('direct children of container are not treated as env-specific', async () => {
    const g = await multiDirTest({
      dirs: {
        '/tmp/varlock-test/dir1/': {
          '.env.schema': outdent`
            ITEM1=from-dir1
          `,
        },
        '/tmp/varlock-test/dir2/': {
          '.env.schema': outdent`
            ITEM2=from-dir2
          `,
        },
      },
    });

    // The root DirectoryDataSource children should NOT be env-specific
    const rootChildren = g.rootDataSource?.children ?? [];
    for (const child of rootChildren) {
      expect(child.isEnvSpecific).toBe(false);
    }
  });

  test('single path in array behaves like regular directory loading', async () => {
    const g = await multiDirTest({
      dirs: {
        '/tmp/varlock-test/dir1/': {
          '.env.schema': outdent`
            ITEM1=from-dir1
          `,
          '.env': outdent`
            ITEM1=from-dir1-env
          `,
        },
      },
    });

    await g.resolveEnvValues();

    // .env overrides .env.schema
    expect(g.configSchema.ITEM1?.resolvedValue).toBe('from-dir1-env');
  });

  test('no loading errors when all directories exist (virtual)', async () => {
    const g = await multiDirTest({
      dirs: {
        '/tmp/varlock-test/dir1/': {
          '.env.schema': 'ITEM1=val1',
        },
        '/tmp/varlock-test/dir2/': {
          '.env.schema': 'ITEM2=val2',
        },
      },
    });

    const sourcesWithLoadingErrors = g.sortedDataSources.filter((s) => s.loadingError);
    expect(sourcesWithLoadingErrors).toHaveLength(0);
  });
});
