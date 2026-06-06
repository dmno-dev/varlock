import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';

async function loadGraph(envFile: string) {
  const graph = new EnvGraph();
  const source = new DotEnvFileDataSource('.env.schema', { overrideContents: envFile });
  await graph.setRootDataSource(source);
  await graph.finishLoad();
  await graph.resolveEnvValues();
  return graph;
}

describe('proxy decorators', () => {
  test('item @proxy implies sensitive', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      BASELINE=1

      # @proxy(domain="api.example.com")
      API_KEY=secret-value
    `);

    const item = graph.configSchema.API_KEY;
    expect(item.isSensitive).toBe(true);
  });

  test('collects attached and detached proxy rules', async () => {
    const graph = await loadGraph(outdent`
      # @enableProxy(egress="strict")
      # @proxy(domain="api.example.com")
      # ---
      BASELINE=1

      # @proxy(domain="api.stripe.com")
      STRIPE_KEY=sk_live_real

      DETACHED_KEY=detached-secret
    `);

    const rules = await graph.getProxyRules();
    expect(rules).toMatchObject([
      {
        source: 'detached',
        domain: ['api.example.com'],
        itemKeys: [],
      },
    ]);
  });

  test('proxy managed items generate placeholders by priority', async () => {
    const graph = await loadGraph(outdent`
      # ---
      BASELINE=1

      # @proxy(domain="api.example.com")
      # @placeholder=sk_test_explicit
      EXPLICIT_KEY=sk_live_real_explicit

      # @proxy(domain="api.example.com")
      # @example=ghp_ABCD1234WXYZ
      EXAMPLE_KEY=ghp_REAL_SECRET

      # @proxy(domain="api.example.com")
      # @type=string(startsWith=tok_, isLength=12)
      TYPE_KEY=tok_real_secret
    `);

    const managed = await graph.getProxyManagedItems();
    const byKey = Object.fromEntries(managed.map((item) => [item.key, item]));

    expect(byKey.EXPLICIT_KEY?.placeholder).toBe('sk_test_explicit');
    expect(byKey.EXAMPLE_KEY?.placeholder).toBe('ghp_000000000000');
    expect(byKey.TYPE_KEY?.placeholder).toBe('tok_00000000');

    expect(byKey.EXPLICIT_KEY?.realValue).toBe('sk_live_real_explicit');
    expect(byKey.EXAMPLE_KEY?.realValue).toBe('ghp_REAL_SECRET');
    expect(byKey.TYPE_KEY?.realValue).toBe('tok_real_secret');
  });
});
