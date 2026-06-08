import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../../../env-graph';
import { getBlockedSensitiveKeys } from '../proxy.command.js';

async function loadGraph(envFile: string) {
  const graph = new EnvGraph();
  const source = new DotEnvFileDataSource('.env.schema', { overrideContents: envFile });
  await graph.setRootDataSource(source);
  await graph.finishLoad();
  await graph.resolveEnvValues();
  return graph;
}

describe('getBlockedSensitiveKeys', () => {
  test('blocks unmanaged sensitive keys by default', async () => {
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
    expect(getBlockedSensitiveKeys(graph, managedItems)).toEqual(['UNMANAGED_SECRET']);
  });

  test('allows unmanaged sensitive key when @proxyPassthrough is present', async () => {
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
    expect(getBlockedSensitiveKeys(graph, managedItems)).toEqual([]);
  });
});
