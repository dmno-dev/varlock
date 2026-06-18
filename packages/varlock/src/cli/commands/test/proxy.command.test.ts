import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../../../env-graph';
import { computeProxyChildView, isCwdWithin } from '../proxy.command.js';

async function loadGraph(envFile: string) {
  const graph = new EnvGraph();
  const source = new DotEnvFileDataSource('.env.schema', { overrideContents: envFile });
  await graph.setRootDataSource(source);
  await graph.finishLoad();
  await graph.resolveEnvValues();
  return graph;
}

async function childView(graph: EnvGraph) {
  const managedItems = await graph.getProxyManagedItems();
  return computeProxyChildView(graph, managedItems);
}

describe('computeProxyChildView', () => {
  test('gives an unmanaged sensitive key a placeholder by default (not omitted)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      BASELINE=1

      # @proxy(domain="api.example.com")
      PROXIED_SECRET=secret-proxied

      # @sensitive
      UNMANAGED_SECRET=secret-unmanaged
    `);

    const view = await childView(graph);
    // both the managed and the default-sensitive item get a placeholder
    expect(Object.keys(view.placeholderByKey).sort()).toEqual(['PROXIED_SECRET', 'UNMANAGED_SECRET']);
    expect(view.placeholderByKey.UNMANAGED_SECRET).not.toBe('secret-unmanaged');
    expect(view.omittedKeys).toEqual([]);
    // non-sensitive baseline is left alone
    expect(view.placeholderByKey.BASELINE).toBeUndefined();
  });

  test('placeholders are unique across items (no scrub collisions)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @sensitive
      A_SECRET=aaa

      # @sensitive
      B_SECRET=bbb
    `);

    const view = await childView(graph);
    const placeholders = Object.values(view.placeholderByKey);
    expect(new Set(placeholders).size).toBe(placeholders.length);
  });

  test('does not placeholder/omit a sensitive key marked @proxy=passthrough', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @sensitive
      # @proxy=passthrough
      PASS_SECRET=secret-allowed
    `);

    const view = await childView(graph);
    expect(view.placeholderByKey.PASS_SECRET).toBeUndefined();
    expect(view.omittedKeys).toEqual([]);
  });

  test('omits a key marked @proxy=omit explicitly (regardless of sensitivity)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy=omit
      PLAIN_BUT_OMITTED=whatever

      # @sensitive
      # @proxy=omit
      SECRET_OMITTED=secret
    `);

    const view = await childView(graph);
    expect(view.omittedKeys.sort()).toEqual(['PLAIN_BUT_OMITTED', 'SECRET_OMITTED']);
    expect(view.placeholderByKey.PLAIN_BUT_OMITTED).toBeUndefined();
    expect(view.placeholderByKey.SECRET_OMITTED).toBeUndefined();
  });

  test('does not touch varlock-reserved (_VARLOCK_*) keys — they are internal infra', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @sensitive
      _VARLOCK_ENV_KEY=deadbeef

      # @sensitive
      USER_SECRET=some-secret
    `);

    const view = await childView(graph);
    expect(view.placeholderByKey._VARLOCK_ENV_KEY).toBeUndefined();
    expect(Object.keys(view.placeholderByKey)).toEqual(['USER_SECRET']);
    expect(view.omittedKeys).toEqual([]);
  });

  test('does not placeholder/omit non-sensitive keys with no policy', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      PLAIN=just-a-value

      # @sensitive
      # @proxy(domain="api.example.com")
      PROXIED_SECRET=secret-proxied
    `);

    const view = await childView(graph);
    expect(view.placeholderByKey.PLAIN).toBeUndefined();
    expect(Object.keys(view.placeholderByKey)).toEqual(['PROXIED_SECRET']);
    expect(view.omittedKeys).toEqual([]);
  });
});

describe('isCwdWithin (proxy run attach matching)', () => {
  test('matches the same dir and subdirectories, not siblings or ancestors', () => {
    expect(isCwdWithin('/a/b', '/a/b')).toBe(true); // same
    expect(isCwdWithin('/a/b/c', '/a/b')).toBe(true); // subdir
    expect(isCwdWithin('/a', '/a/b')).toBe(false); // ancestor
    expect(isCwdWithin('/a/bcd', '/a/b')).toBe(false); // sibling sharing a prefix
    expect(isCwdWithin('/x/y', '/a/b')).toBe(false); // unrelated
  });
});
