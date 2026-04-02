import {
  describe, test, expect, vi, beforeEach, afterEach,
} from 'vitest';
import outdent from 'outdent';
import path from 'node:path';
import {
  EnvGraph, DirectoryDataSource,
} from '../../index';

// Helper similar to envFilesTest but for testing graph loading
async function loadGraph(spec: {
  files: Record<string, string>;
  fallbackEnv?: string;
}) {
  const currentDir = path.dirname(expect.getState().testPath!);
  vi.spyOn(process, 'cwd').mockReturnValue(currentDir);

  const g = new EnvGraph();
  if (spec.fallbackEnv) g.envFlagFallback = spec.fallbackEnv;
  g.setVirtualImports(currentDir, spec.files);
  const source = new DirectoryDataSource(currentDir);
  await g.setRootDataSource(source);
  await g.finishLoad();
  return g;
}

describe('remote imports - security', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('public-schemas: import with invalid path (contains ..) should error', async () => {
    // Mock the fetch to avoid actual network calls
    const mockFetch = vi.fn().mockRejectedValue(new Error('should not be called'));
    vi.doMock('../../lib/schema-cache', () => ({
      fetchPublicSchema: mockFetch,
    }));

    const g = await loadGraph({
      files: {
        '.env.schema': outdent`
          # @import(public-schemas:../../../etc/passwd)
          # ---
          ITEM1=value
        `,
      },
    });

    // Should have a loading error due to the invalid path
    expect(
      g.sortedDataSources.some((s) => s.loadingError),
      'Expected a loading error for invalid path',
    ).toBeTruthy();
  });

  test('http imports should still show not supported error', async () => {
    const g = await loadGraph({
      files: {
        '.env.schema': outdent`
          # @import(https://example.com/.env.schema)
          # ---
          ITEM1=value
        `,
      },
    });

    const errorSource = g.sortedDataSources.find((s) => s.loadingError);
    expect(errorSource?.loadingError?.message).toContain('http imports not supported yet');
  });

  test('npm imports should still show not supported error', async () => {
    const g = await loadGraph({
      files: {
        '.env.schema': outdent`
          # @import(npm:some-package@1.0.0/.env)
          # ---
          ITEM1=value
        `,
      },
    });

    const errorSource = g.sortedDataSources.find((s) => s.loadingError);
    expect(errorSource?.loadingError?.message).toContain('npm imports not supported yet');
  });

  test('unsupported import protocol should error', async () => {
    const g = await loadGraph({
      files: {
        '.env.schema': outdent`
          # @import(ftp://example.com/.env.schema)
          # ---
          ITEM1=value
        `,
      },
    });

    const errorSource = g.sortedDataSources.find((s) => s.loadingError);
    expect(errorSource?.loadingError?.message).toContain('unsupported import type');
  });

  test('plugin-schema: import with empty plugin name should error', async () => {
    const g = await loadGraph({
      files: {
        '.env.schema': outdent`
          # @import(plugin-schema:)
          # ---
          ITEM1=value
        `,
      },
    });

    const errorSource = g.sortedDataSources.find((s) => s.loadingError);
    expect(errorSource?.loadingError?.message).toContain('must specify a plugin name');
  });
});
