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
      {
        source: 'attached',
        domain: ['api.stripe.com'],
        itemKeys: ['STRIPE_KEY'],
      },
    ]);
  });

  test('a header-level (detached) @proxy is not rejected as a misplaced item decorator', async () => {
    const graph = await loadGraph(outdent`
      # @enableProxy(egress="strict")
      # @proxy(domain="api.a.com")
      # @proxy(domain="api.b.com", path="/admin/**", approve=true)
      # ---
      BASELINE=1
    `);

    // @proxy is registered as both a root and item decorator; using it in the
    // header must NOT raise "Item decorator @proxy cannot be used in the file header".
    const errors = graph.sortedDataSources.flatMap((s) => s.errors).filter((e) => !e.isWarning);
    expect(errors).toEqual([]);

    // ...and both detached rules are collected, including the approve rule.
    const rules = await graph.getProxyRules();
    expect(rules).toMatchObject([
      { source: 'detached', domain: ['api.a.com'] },
      {
        source: 'detached', domain: ['api.b.com'], path: '/admin/**', approve: true,
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
      # @type=string(startsWith=tok_, isLength=12)
      TYPE_KEY=tok_real_secret

      # @proxy(domain="api.example.com")
      NO_HINT_KEY=whatever_real_secret
    `);

    const managed = await graph.getProxyManagedItems();
    const byKey = Object.fromEntries(managed.map((item) => [item.key, item]));

    // Explicit @placeholder wins; @type constraints derive a format-shaped placeholder.
    expect(byKey.EXPLICIT_KEY?.placeholder).toBe('sk_test_explicit');
    expect(byKey.TYPE_KEY?.placeholder).toBe('tok_00000000');
    expect(byKey.EXPLICIT_KEY?.placeholderIsGenericFallback).toBeFalsy();
    expect(byKey.TYPE_KEY?.placeholderIsGenericFallback).toBeFalsy();

    // No format hint → generic fallback, flagged so the CLI can warn.
    expect(byKey.NO_HINT_KEY?.placeholder).toMatch(/^vlk_placeholder_NO_HINT_KEY_/);
    expect(byKey.NO_HINT_KEY?.placeholderIsGenericFallback).toBe(true);

    expect(byKey.EXPLICIT_KEY?.realValue).toBe('sk_live_real_explicit');
    expect(byKey.TYPE_KEY?.realValue).toBe('tok_real_secret');
    expect(byKey.NO_HINT_KEY?.realValue).toBe('whatever_real_secret');
  });
});
