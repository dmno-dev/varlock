import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../../../env-graph';
import {
  buildProxiedChildEnv, computeProxyChildView, isCwdWithin, resolveReloadMode, createReloadKeypressHandler,
} from '../proxy.command.js';

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

describe('createReloadKeypressHandler (two-step r -> y reload)', () => {
  function make() {
    const calls: Array<string> = [];
    const h = createReloadKeypressHandler({
      onArm: () => calls.push('arm'),
      onCancel: () => calls.push('cancel'),
      onConfirm: () => calls.push('confirm'),
    });
    return { h, calls };
  }

  test('r arms, then y confirms', () => {
    const { h, calls } = make();
    h.handleKey('r');
    expect(h.state()).toBe('confirming');
    expect(calls).toEqual(['arm']);
    h.handleKey('y');
    expect(h.state()).toBe('idle');
    expect(calls).toEqual(['arm', 'confirm']);
  });

  test('r then any non-y cancels (a stray key cannot reload)', () => {
    const { h, calls } = make();
    h.handleKey('r');
    h.handleKey('n');
    expect(h.state()).toBe('idle');
    expect(calls).toEqual(['arm', 'cancel']);
    // and it takes two keys again to reload (no single-key reload)
    h.handleKey('y'); // ignored in idle
    expect(calls).toEqual(['arm', 'cancel']);
  });

  test('a lone key in idle does nothing; R and Y are accepted', () => {
    const { h, calls } = make();
    h.handleKey('x');
    expect(calls).toEqual([]);
    h.handleKey('R');
    h.handleKey('Y');
    expect(calls).toEqual(['arm', 'confirm']);
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

describe('buildProxiedChildEnv', () => {
  const PAYLOAD = {
    env: {
      API_KEY: 'vlk_placeholder_API_KEY_abc',
      LOG_LEVEL: 'info',
    },
    omittedKeys: ['ADMIN_TOKEN'],
    serializedGraph: {
      sources: [],
      settings: {},
      config: {
        API_KEY: { value: 'vlk_placeholder_API_KEY_abc', isSensitive: true },
        LOG_LEVEL: { value: 'info', isSensitive: false },
      },
    },
  } as any;
  const SESSION_EXPORT = { HTTP_PROXY: 'http://127.0.0.1:9999', __VARLOCK_PROXY_CHILD: '1' };

  test('payload values win over the launching shell (an accidentally exported real key never reaches the child)', () => {
    const env = buildProxiedChildEnv({
      payload: PAYLOAD,
      sessionExportEnv: SESSION_EXPORT,
      parentPid: 123,
      injectVars: true,
      injectBlob: true,
      baseEnv: { API_KEY: 'sk-REAL-oops', LOG_LEVEL: 'debug', PATH: '/usr/bin' },
    });
    expect(env.API_KEY).toBe('vlk_placeholder_API_KEY_abc');
    expect(env.LOG_LEVEL).toBe('info');
    // ambient OS env still flows through
    expect(env.PATH).toBe('/usr/bin');
    // plumbing + markers land
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:9999');
    expect(env.__VARLOCK_PROXY_PARENT_PID).toBe('123');
    expect(env.__VARLOCK_RUN).toBe('1');
    expect(env.__VARLOCK_ENV).toBe(JSON.stringify(PAYLOAD.serializedGraph));
  });

  test('omitted keys are absent even when the shell exports them', () => {
    const env = buildProxiedChildEnv({
      payload: PAYLOAD,
      sessionExportEnv: SESSION_EXPORT,
      parentPid: 123,
      injectVars: true,
      injectBlob: true,
      baseEnv: { ADMIN_TOKEN: 'real-admin-token-from-shell' },
    });
    expect('ADMIN_TOKEN' in env).toBe(false);
  });

  test('inject mode blob-only keeps _VARLOCK_ENV_KEY and skips plain vars', () => {
    const env = buildProxiedChildEnv({
      payload: PAYLOAD,
      sessionExportEnv: SESSION_EXPORT,
      parentPid: 1,
      injectVars: false,
      injectBlob: true,
      baseEnv: { _VARLOCK_ENV_KEY: 'enc-key', API_KEY: 'ambient' },
    });
    // no var injection: the ambient value survives (blob consumers resolve via the graph)
    expect(env.API_KEY).toBe('ambient');
    expect(env._VARLOCK_ENV_KEY).toBe('enc-key');
    expect(env.__VARLOCK_ENV).toBeDefined();
  });

  test('inject mode vars-only skips the blob', () => {
    const env = buildProxiedChildEnv({
      payload: PAYLOAD,
      sessionExportEnv: SESSION_EXPORT,
      parentPid: 1,
      injectVars: true,
      injectBlob: false,
      baseEnv: {},
    });
    expect(env.API_KEY).toBe('vlk_placeholder_API_KEY_abc');
    expect(env.__VARLOCK_ENV).toBeUndefined();
  });
});
