import { describe, test, expect } from 'vitest';
import { varlockLoad } from '../helpers/run-varlock.js';

describe('Convex Integration', () => {
  const CWD = 'smoke-test-convex';

  test('varlock load succeeds with convex plugin', () => {
    const result = varlockLoad({ cwd: CWD });
    expect(result.exitCode).toBe(0);
  });

  test('varlock load --format json-full includes syncTargets', () => {
    const result = varlockLoad({ cwd: CWD, format: 'json-full' });
    expect(result.exitCode).toBe(0);

    const graph = JSON.parse(result.stdout);

    // Items with @syncTarget(convex) should have syncTargets populated
    expect(graph.config.DATABASE_URL.syncTargets).toEqual(['convex']);
    expect(graph.config.PORT.syncTargets).toEqual(['convex']);
    expect(graph.config.NODE_ENV.syncTargets).toEqual(['convex']);
    expect(graph.config.API_KEY.syncTargets).toEqual(['convex']);

    // Item without @syncTarget should NOT have syncTargets
    expect(graph.config.INTERNAL_DEBUG.syncTargets).toBeUndefined();
  });

  test('sensitive flags are preserved in serialized output', () => {
    const result = varlockLoad({ cwd: CWD, format: 'json-full' });
    expect(result.exitCode).toBe(0);

    const graph = JSON.parse(result.stdout);

    expect(graph.config.API_KEY.isSensitive).toBe(true);
    expect(graph.config.DATABASE_URL.isSensitive).toBe(false);
    expect(graph.config.PORT.isSensitive).toBe(false);
  });

  test('resolved values are correct', () => {
    const result = varlockLoad({ cwd: CWD, format: 'json' });
    expect(result.exitCode).toBe(0);

    const envObj = JSON.parse(result.stdout);

    expect(envObj.DATABASE_URL).toBe('postgres://localhost:5432/testdb');
    expect(envObj.PORT).toBe(3000);
    // NODE_ENV may be overridden by the test runner (vitest sets NODE_ENV=test)
    expect(envObj.NODE_ENV).toBeDefined();
    expect(envObj.INTERNAL_DEBUG).toBe(false);
    expect(envObj.API_KEY).toBe('test-api-key-12345');
  });

  test('filtering: only convex-targeted items are selected', () => {
    const result = varlockLoad({ cwd: CWD, format: 'json-full' });
    expect(result.exitCode).toBe(0);

    const graph = JSON.parse(result.stdout);

    // Count items with convex sync target
    const convexItems = Object.entries(graph.config)
      .filter(([, item]: [string, any]) => item.syncTargets?.includes('convex'));

    // Should be 4: DATABASE_URL, PORT, NODE_ENV, API_KEY
    // INTERNAL_DEBUG should NOT be included
    expect(convexItems).toHaveLength(4);

    const convexKeys = convexItems.map(([key]: [string, any]) => key);
    expect(convexKeys).toContain('DATABASE_URL');
    expect(convexKeys).toContain('PORT');
    expect(convexKeys).toContain('NODE_ENV');
    expect(convexKeys).toContain('API_KEY');
    expect(convexKeys).not.toContain('INTERNAL_DEBUG');
  });

  test('blob building: stripped graph fits under 8KB', () => {
    const result = varlockLoad({ cwd: CWD, format: 'json-full' });
    expect(result.exitCode).toBe(0);

    const graph = JSON.parse(result.stdout);

    // Build a minimal blob (strip basePath and sources)
    const minimalGraph = {
      settings: graph.settings,
      config: {} as Record<string, any>,
    };
    for (const [key, item] of Object.entries(graph.config) as Array<[string, any]>) {
      if (item.syncTargets?.includes('convex')) {
        minimalGraph.config[key] = {
          value: item.value,
          isSensitive: item.isSensitive,
        };
      }
    }

    const blob = JSON.stringify(minimalGraph);
    const blobSize = Buffer.byteLength(blob, 'utf-8');

    // This small fixture should be well under 8KB
    expect(blobSize).toBeLessThan(8192);
    // And should contain only convex-targeted items
    expect(Object.keys(minimalGraph.config)).toHaveLength(4);
  });

  test('secret-zero flow simulation: auth vars excluded from sync', () => {
    // This test simulates the secret-zero pattern where OP_TOKEN is used
    // for 1Password auth but should NOT be synced to Convex.
    // Since we can't use real 1Password in smoke tests, we verify the
    // filtering logic works by checking that items WITHOUT @syncTarget(convex)
    // are excluded from the sync set.
    const result = varlockLoad({ cwd: CWD, format: 'json-full' });
    expect(result.exitCode).toBe(0);

    const graph = JSON.parse(result.stdout);

    // INTERNAL_DEBUG simulates an auth-only var (no @syncTarget)
    const allKeys = Object.keys(graph.config).filter((k) => !k.startsWith('VARLOCK_'));
    const convexKeys = allKeys.filter((k) => graph.config[k].syncTargets?.includes('convex'));
    const excludedKeys = allKeys.filter((k) => !graph.config[k].syncTargets?.includes('convex'));

    expect(convexKeys).not.toHaveLength(0);
    expect(excludedKeys).not.toHaveLength(0);
    expect(excludedKeys).toContain('INTERNAL_DEBUG');
  });
});
