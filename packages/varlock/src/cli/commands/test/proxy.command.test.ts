import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../../../env-graph';
import { getOmittedSensitiveKeys } from '../proxy.command.js';

async function loadGraph(envFile: string) {
  const graph = new EnvGraph();
  const source = new DotEnvFileDataSource('.env.schema', { overrideContents: envFile });
  await graph.setRootDataSource(source);
  await graph.finishLoad();
  await graph.resolveEnvValues();
  return graph;
}

describe('getOmittedSensitiveKeys', () => {
  test('omits unmanaged sensitive keys by default', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      BASELINE=1

      # @proxy(domain="api.example.com")
      PROXIED_SECRET=secret-proxied

      # @sensitive
      UNMANAGED_SECRET=secret-unmanaged
    `);

    const managedItems = await graph.getProxyManagedItems();
    // unmanaged + sensitive + no passthrough → omitted from the child
    expect(getOmittedSensitiveKeys(graph, managedItems)).toEqual(['UNMANAGED_SECRET']);
  });

  test('does not omit an unmanaged sensitive key marked @proxyPassthrough', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      BASELINE=1

      # @proxy(domain="api.example.com")
      PROXIED_SECRET=secret-proxied

      # @sensitive
      # @proxyPassthrough
      UNMANAGED_ALLOWED=secret-allowed
    `);

    const managedItems = await graph.getProxyManagedItems();
    expect(getOmittedSensitiveKeys(graph, managedItems)).toEqual([]);
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

    const managedItems = await graph.getProxyManagedItems();
    // _VARLOCK_ENV_KEY is internal plumbing, not a user secret needing a policy.
    expect(getOmittedSensitiveKeys(graph, managedItems)).toEqual(['USER_SECRET']);
  });

  test('does not omit non-sensitive keys', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      PLAIN=just-a-value

      # @sensitive
      # @proxy(domain="api.example.com")
      PROXIED_SECRET=secret-proxied
    `);

    const managedItems = await graph.getProxyManagedItems();
    expect(getOmittedSensitiveKeys(graph, managedItems)).toEqual([]);
  });
});
