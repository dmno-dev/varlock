import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../../../env-graph';
import { computeProxyChildView, isCwdWithin, resolveReloadMode } from '../proxy.command.js';

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

describe('resolveReloadMode', () => {
  test('the flag wins: --allow-reload -> manual, --no-allow-reload -> off', () => {
    // flag overrides schema and context in both directions
    expect(resolveReloadMode({
      flag: true, schema: 'off', isStart: false, hasTty: false,
    }))
      .toEqual({ mode: 'manual', resolvedFromAuto: false });
    expect(resolveReloadMode({
      flag: false, schema: 'manual', isStart: true, hasTty: true,
    }))
      .toEqual({ mode: 'off', resolvedFromAuto: false });
  });

  test('an explicit schema value (off/manual) is used verbatim', () => {
    expect(resolveReloadMode({
      flag: undefined, schema: 'manual', isStart: false, hasTty: false,
    }))
      .toEqual({ mode: 'manual', resolvedFromAuto: false });
    expect(resolveReloadMode({
      flag: undefined, schema: 'off', isStart: true, hasTty: true,
    }))
      .toEqual({ mode: 'off', resolvedFromAuto: false });
  });

  test('auto (explicit or defaulted) resolves conservatively from launch context', () => {
    const auto = (isStart: boolean, hasTty: boolean) => resolveReloadMode({
      flag: undefined, schema: 'auto', isStart, hasTty,
    });
    // manual only for an interactive `proxy start`; off everywhere else
    expect(auto(true, true)).toEqual({ mode: 'manual', resolvedFromAuto: true });
    expect(auto(true, false)).toEqual({ mode: 'off', resolvedFromAuto: true }); // headless daemon
    expect(auto(false, true)).toEqual({ mode: 'off', resolvedFromAuto: true }); // one-shot `proxy run`
    expect(auto(false, false)).toEqual({ mode: 'off', resolvedFromAuto: true });
    // no schema value defaults to auto
    expect(resolveReloadMode({
      flag: undefined, schema: undefined, isStart: true, hasTty: true,
    }))
      .toEqual({ mode: 'manual', resolvedFromAuto: true });
  });
});

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

describe('@proxy nested rules=[...] form', () => {
  test('desugars to the parent inject rule plus one policy rule per entry (domain written once)', async () => {
    const graph = await loadGraph(outdent`
      # @proxyConfig={egress="strict"}
      # ---
      # @proxy(domain="api.stripe.com", rules=[
      #   {path="/v1/refunds/**", method=[POST, DELETE], block=true},
      #   {path="/v1/payouts/**", block=true},
      # ])
      STRIPE_SECRET_KEY=sk_live_realsecret
    `);
    const rules = await graph.getProxyRules();
    expect(rules).toHaveLength(3);

    // parent rule injects the item across the domain
    expect(rules[0]).toMatchObject({ domain: ['api.stripe.com'], itemKeys: ['STRIPE_SECRET_KEY'] });
    expect(rules[0].path).toBeUndefined();
    expect(rules[0].block).toBeUndefined();

    // entries are policy-only refinements (no injection), inheriting the domain
    expect(rules[1]).toMatchObject({
      domain: ['api.stripe.com'], itemKeys: [], path: '/v1/refunds/**', method: ['POST', 'DELETE'], block: true,
    });
    expect(rules[2]).toMatchObject({
      domain: ['api.stripe.com'], itemKeys: [], path: '/v1/payouts/**', block: true,
    });
  });

  test('a detached header rules=[...] block inherits the domain and injects nothing', async () => {
    const graph = await loadGraph(outdent`
      # @proxyConfig={egress="strict"}
      # @proxy(domain="api.example.com", rules=[{path="/admin/**", block=true}])
      # ---
      FOO=bar
    `);
    const rules = await graph.getProxyRules();
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => r.itemKeys.length === 0)).toBe(true);
    expect(rules[1]).toMatchObject({ domain: ['api.example.com'], path: '/admin/**', block: true });
  });

  test('rejects an entry that tries to re-set domain (injection is the parent rule\'s job)', async () => {
    const graph = await loadGraph(outdent`
      # @proxy(domain="api.example.com", rules=[{domain="evil.com", block=true}])
      # ---
      FOO=bar
    `);
    await expect(graph.getProxyRules()).rejects.toThrow(/unknown option "domain" in a rules entry/);
  });
});
