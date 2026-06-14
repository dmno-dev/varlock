import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../../../env-graph';
import { getProxyOmittedKeys, isCwdWithin } from '../proxy.command.js';

async function loadGraph(envFile: string) {
  const graph = new EnvGraph();
  const source = new DotEnvFileDataSource('.env.schema', { overrideContents: envFile });
  await graph.setRootDataSource(source);
  await graph.finishLoad();
  await graph.resolveEnvValues();
  return graph;
}

async function omittedKeys(graph: EnvGraph) {
  const managedItems = await graph.getProxyManagedItems();
  return getProxyOmittedKeys(graph, managedItems);
}

describe('getProxyOmittedKeys', () => {
  test('omits an unmanaged sensitive key by default (implicit — warned)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      BASELINE=1

      # @proxy(domain="api.example.com")
      PROXIED_SECRET=secret-proxied

      # @sensitive
      UNMANAGED_SECRET=secret-unmanaged
    `);

    expect(await omittedKeys(graph)).toEqual([{ key: 'UNMANAGED_SECRET', explicit: false }]);
  });

  test('does not omit a sensitive key marked @proxy=passthrough', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @sensitive
      # @proxy=passthrough
      PASS_SECRET=secret-allowed
    `);

    expect(await omittedKeys(graph)).toEqual([]);
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

    expect(await omittedKeys(graph)).toEqual([
      { key: 'PLAIN_BUT_OMITTED', explicit: true },
      { key: 'SECRET_OMITTED', explicit: true },
    ]);
  });

  test('does not omit varlock-reserved (_VARLOCK_*) keys — they are internal infra', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @sensitive
      _VARLOCK_ENV_KEY=deadbeef

      # @sensitive
      USER_SECRET=some-secret
    `);

    expect(await omittedKeys(graph)).toEqual([{ key: 'USER_SECRET', explicit: false }]);
  });

  test('does not omit non-sensitive keys with no policy', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      PLAIN=just-a-value

      # @sensitive
      # @proxy(domain="api.example.com")
      PROXIED_SECRET=secret-proxied
    `);

    expect(await omittedKeys(graph)).toEqual([]);
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
