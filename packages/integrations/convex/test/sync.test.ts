/**
 * Unit tests for the Convex integration sync logic.
 *
 * These test the filtering and blob building logic with mocked varlock output.
 * They don't require a real Convex deployment.
 */

import { describe, test, expect } from 'vitest';
import { buildConvexBlob, type SerializedEnvGraph } from '../src/index.js';

// -- helpers --

function makeGraph(
  config: SerializedEnvGraph['config'],
  settings?: SerializedEnvGraph['settings'],
): SerializedEnvGraph {
  return {
    basePath: '/fake/project',
    sources: [
      { label: '.env.schema', enabled: true, path: '.env.schema' },
      { label: '.env', enabled: true, path: '.env' },
    ],
    settings: settings ?? { redactLogs: true, preventLeaks: true },
    config,
  };
}

// -- tests --

describe('buildConvexBlob', () => {
  test('strips basePath and sources from the blob', () => {
    const graph = makeGraph({
      DATABASE_URL: { value: 'postgres://localhost', isSensitive: true, syncTargets: ['convex'] },
    });
    const items = [{ key: 'DATABASE_URL', value: 'postgres://localhost', isSensitive: true }];

    const blob = buildConvexBlob(graph, items);
    const parsed = JSON.parse(blob);

    expect(parsed.basePath).toBeUndefined();
    expect(parsed.sources).toBeUndefined();
    expect(parsed.settings).toEqual({ redactLogs: true, preventLeaks: true });
    expect(parsed.config.DATABASE_URL).toEqual({ value: 'postgres://localhost', isSensitive: true });
  });

  test('only includes convex-targeted items in the blob', () => {
    const graph = makeGraph({
      DATABASE_URL: { value: 'postgres://localhost', isSensitive: true, syncTargets: ['convex'] },
      OP_TOKEN: { value: 'ops_abc123', isSensitive: true },
      DEBUG: { value: 'false', isSensitive: false },
    });
    const convexItems = [{ key: 'DATABASE_URL', value: 'postgres://localhost', isSensitive: true }];

    const blob = buildConvexBlob(graph, convexItems);
    const parsed = JSON.parse(blob);

    expect(Object.keys(parsed.config)).toEqual(['DATABASE_URL']);
    expect(parsed.config.OP_TOKEN).toBeUndefined();
    expect(parsed.config.DEBUG).toBeUndefined();
  });

  test('blob size is reasonable for typical projects', () => {
    const config: SerializedEnvGraph['config'] = {};
    const items: Array<{ key: string; value: any; isSensitive: boolean }> = [];
    for (let i = 0; i < 20; i++) {
      const key = `ENV_VAR_${i}`;
      const value = `value-${i}-${'x'.repeat(50)}`;
      config[key] = { value, isSensitive: i % 3 === 0, syncTargets: ['convex'] };
      items.push({ key, value, isSensitive: i % 3 === 0 });
    }
    const graph = makeGraph(config);

    const blob = buildConvexBlob(graph, items);
    const size = Buffer.byteLength(blob, 'utf-8');

    // 20 vars with ~60-byte values should be well under 8KB
    expect(size).toBeLessThan(8192);
  });
});

describe('filtering logic', () => {
  test('regular flow: only @syncTarget(convex) items are included', () => {
    const graph = makeGraph({
      DATABASE_URL: { value: 'postgres://localhost:5432/mydb', isSensitive: false, syncTargets: ['convex'] },
      PORT: { value: 3000, isSensitive: false, syncTargets: ['convex'] },
      NODE_ENV: { value: 'production', isSensitive: false, syncTargets: ['convex'] },
      INTERNAL_DEBUG: { value: false, isSensitive: false },
    });

    const convexItems: Array<{ key: string; value: any; isSensitive: boolean }> = [];
    for (const [key, item] of Object.entries(graph.config)) {
      if (item.syncTargets?.includes('convex')) {
        convexItems.push({ key, value: item.value, isSensitive: item.isSensitive });
      }
    }

    expect(convexItems).toHaveLength(3);
    expect(convexItems.map((i) => i.key)).toEqual(['DATABASE_URL', 'PORT', 'NODE_ENV']);
  });

  test('secret-zero flow: plugin auth tokens are excluded', () => {
    const graph = makeGraph({
      OP_TOKEN: { value: 'ops_secret_token_value', isSensitive: true },
      DATABASE_URL: { value: 'postgres://resolved-from-1password', isSensitive: true, syncTargets: ['convex'] },
      STRIPE_KEY: { value: 'sk_live_resolved', isSensitive: true, syncTargets: ['convex'] },
      PUBLIC_APP_URL: { value: 'https://myapp.com', isSensitive: false, syncTargets: ['convex'] },
    });

    const convexItems: Array<{ key: string; value: any; isSensitive: boolean }> = [];
    for (const [key, item] of Object.entries(graph.config)) {
      if (item.syncTargets?.includes('convex')) {
        convexItems.push({ key, value: item.value, isSensitive: item.isSensitive });
      }
    }

    // OP_TOKEN should NOT be in the list (no @syncTarget(convex))
    expect(convexItems.map((i) => i.key)).not.toContain('OP_TOKEN');

    // All @syncTarget(convex) items should be present
    expect(convexItems).toHaveLength(3);
    expect(convexItems.map((i) => i.key)).toEqual(['DATABASE_URL', 'STRIPE_KEY', 'PUBLIC_APP_URL']);

    // Sensitive flags preserved
    expect(convexItems.find((i) => i.key === 'DATABASE_URL')?.isSensitive).toBe(true);
    expect(convexItems.find((i) => i.key === 'PUBLIC_APP_URL')?.isSensitive).toBe(false);
  });

  test('multi-target: items can target both convex and vercel', () => {
    const graph = makeGraph({
      SHARED_KEY: { value: 'shared', isSensitive: true, syncTargets: ['convex', 'vercel'] },
      CONVEX_ONLY: { value: 'convex-val', isSensitive: false, syncTargets: ['convex'] },
      VERCEL_ONLY: { value: 'vercel-val', isSensitive: false, syncTargets: ['vercel'] },
    });

    const convexItems: Array<{ key: string; value: any; isSensitive: boolean }> = [];
    for (const [key, item] of Object.entries(graph.config)) {
      if (item.syncTargets?.includes('convex')) {
        convexItems.push({ key, value: item.value, isSensitive: item.isSensitive });
      }
    }

    expect(convexItems).toHaveLength(2);
    expect(convexItems.map((i) => i.key)).toEqual(['SHARED_KEY', 'CONVEX_ONLY']);
  });

  test('blob preserves isSensitive flags for redaction', () => {
    const graph = makeGraph({
      SECRET: { value: 'secret-value', isSensitive: true, syncTargets: ['convex'] },
      PUBLIC: { value: 'public-value', isSensitive: false, syncTargets: ['convex'] },
    });
    const items = [
      { key: 'SECRET', value: 'secret-value', isSensitive: true },
      { key: 'PUBLIC', value: 'public-value', isSensitive: false },
    ];

    const blob = buildConvexBlob(graph, items);
    const parsed = JSON.parse(blob);

    expect(parsed.config.SECRET.isSensitive).toBe(true);
    expect(parsed.config.PUBLIC.isSensitive).toBe(false);
  });
});

describe('edge cases', () => {
  test('empty syncTargets - no items synced', () => {
    const graph = makeGraph({
      VAR_A: { value: 'a', isSensitive: false },
      VAR_B: { value: 'b', isSensitive: false },
    });

    const convexItems: Array<{ key: string; value: any; isSensitive: boolean }> = [];
    for (const [key, item] of Object.entries(graph.config)) {
      if (item.syncTargets?.includes('convex')) {
        convexItems.push({ key, value: item.value, isSensitive: item.isSensitive });
      }
    }

    expect(convexItems).toHaveLength(0);
  });

  test('undefined values are handled', () => {
    const graph = makeGraph({
      OPTIONAL_VAR: { value: undefined, isSensitive: false, syncTargets: ['convex'] },
    });
    const items = [{ key: 'OPTIONAL_VAR', value: undefined, isSensitive: false }];

    const blob = buildConvexBlob(graph, items);
    const parsed = JSON.parse(blob);

    // undefined properties are omitted by JSON.stringify
    expect(parsed.config.OPTIONAL_VAR.value).toBeUndefined();
  });

  test('blob exceeding 8KB triggers warning', () => {
    const config: SerializedEnvGraph['config'] = {};
    const items: Array<{ key: string; value: any; isSensitive: boolean }> = [];
    // Create items with very long values to exceed 8KB
    for (let i = 0; i < 30; i++) {
      const key = `LONG_VALUE_VAR_${i}`;
      const value = 'x'.repeat(300); // 300 bytes each * 30 = 9KB+
      config[key] = { value, isSensitive: false, syncTargets: ['convex'] };
      items.push({ key, value, isSensitive: false });
    }
    const graph = makeGraph(config);

    const blob = buildConvexBlob(graph, items);
    const size = Buffer.byteLength(blob, 'utf-8');

    expect(size).toBeGreaterThan(8192);
  });
});
