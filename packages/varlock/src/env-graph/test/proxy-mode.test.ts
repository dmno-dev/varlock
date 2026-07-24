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
      # @proxyConfig={egress="strict"}
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
        domain: ['api.example.com'],
        itemKeys: [],
      },
      {
        domain: ['api.stripe.com'],
        itemKeys: ['STRIPE_KEY'],
      },
    ]);
  });

  test('domain and method accept array literals (lists)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain=[api.a.com, api.b.com], method=[GET, POST])
      API_KEY=secret
    `);

    expect(await graph.getProxyRules()).toMatchObject([
      {
        domain: ['api.a.com', 'api.b.com'],
        method: ['GET', 'POST'],
        itemKeys: ['API_KEY'],
      },
    ]);
  });

  test('detached rule attaches extra items via keys=[...] array literal', async () => {
    const graph = await loadGraph(outdent`
      # @proxyConfig={egress="strict"}
      # @proxy(domain="api.example.com", keys=[STRIPE_KEY, WEBHOOK_SECRET])
      # ---
      # @sensitive
      STRIPE_KEY=sk_live_real

      # @sensitive
      WEBHOOK_SECRET=whsec_real
    `);

    const rules = await graph.getProxyRules();
    expect(rules).toMatchObject([{ domain: ['api.example.com'], itemKeys: ['STRIPE_KEY', 'WEBHOOK_SECRET'] }]);
    // and those keys become managed (placeholders injected)
    const managed = await graph.getProxyManagedItems();
    expect(managed.map((i) => i.key).sort()).toEqual(['STRIPE_KEY', 'WEBHOOK_SECRET']);
  });

  test('positional args are rejected with a pointer to keys=[...]', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(OTHER_KEY, domain="api.a.com")
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /positional args are not supported.*keys=\[/.test(e.message))).toBe(true);
  });

  test('keys must be an array literal, not a bare value', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", keys=OTHER)
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /keys must be an array literal/.test(e.message))).toBe(true);
  });

  test('an unknown option is rejected (typo fails loud, not silently permissive)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", aproval=true)
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /unknown option "aproval"/.test(e.message))).toBe(true);
  });

  test('block must be a real boolean, not a quoted string', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", block="true")
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /block must be a boolean/.test(e.message))).toBe(true);
  });

  test('path must be a string, not an array literal', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", path=[a, b])
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /path must be a non-empty string/.test(e.message))).toBe(true);
  });

  test('substituteIn parses named targets onto the rule (single value and array literal)', async () => {
    const graph = await loadGraph(outdent`
      # @proxyConfig={egress="strict"}
      # @proxy(domain="api.a.com", substituteIn="body:client_secret")
      # @proxy(domain="api.b.com", substituteIn=[header, "body:token"])
      # @proxy(domain="api.c.com", substituteIn="body:*")
      # @proxy(domain="api.d.com", substituteIn=[path, "query:api_key"])
      # ---
      BASELINE=1
    `);
    expect(await graph.getProxyRules()).toMatchObject([
      { domain: ['api.a.com'], substituteIn: ['body:client_secret'] },
      { domain: ['api.b.com'], substituteIn: ['header', 'body:token'] },
      { domain: ['api.c.com'], substituteIn: ['body:*'] },
      { domain: ['api.d.com'], substituteIn: ['path', 'query:api_key'] },
    ]);
  });

  test('path takes no argument (path:<x> is rejected)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", substituteIn="path:segment")
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /path takes no argument/.test(e.message))).toBe(true);
  });

  test('maxOccurrences parses onto the rule', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", maxOccurrences=2)
      API_KEY=secret
    `);
    expect(await graph.getProxyRules()).toMatchObject([{ domain: ['api.a.com'], maxOccurrences: 2 }]);
  });

  test('an invalid substituteIn target is rejected', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", substituteIn=[header, cookie])
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /invalid substituteIn target "cookie"/.test(e.message))).toBe(true);
  });

  test('bare body (no path) is rejected — body substitution must name a path', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", substituteIn=[header, body])
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /body substitution requires a path/.test(e.message))).toBe(true);
  });

  test('a non-integer maxOccurrences is rejected', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", maxOccurrences=0)
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /maxOccurrences must be an integer >= 1/.test(e.message))).toBe(true);
  });

  test('a header-level (detached) @proxy is not rejected as a misplaced item decorator', async () => {
    const graph = await loadGraph(outdent`
      # @proxyConfig={egress="strict"}
      # @proxy(domain="api.a.com")
      # @proxy(domain="api.b.com", path="/admin/**", approval=true)
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
      { domain: ['api.a.com'] },
      { domain: ['api.b.com'], path: '/admin/**', approval: {} },
    ]);
  });

  test('approval object form: each + maxDuration parse onto the rule', async () => {
    const graph = await loadGraph(outdent`
      # @proxyConfig={egress="strict"}
      # @proxy(domain="api.a.com", approval=true)
      # @proxy(domain="api.b.com", approval={each=request, maxDuration="15m"})
      # @proxy(domain="api.c.com", approval={each=host, maxDuration=0})
      # ---
      BASELINE=1
    `);

    expect(await graph.getProxyRules()).toMatchObject([
      { domain: ['api.a.com'], approval: {} },
      {
        domain: ['api.b.com'], approval: { each: 'request', maxDurationMs: 900_000 },
      },
      {
        domain: ['api.c.com'], approval: { each: 'host', maxDurationMs: 0 },
      },
    ]);
  });

  test('approval object form: enabled=false makes the rule a plain allow (no approval)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", approval={enabled=false, each=request})
      API_KEY=secret
    `);
    const rules = await graph.getProxyRules();
    expect(rules).toMatchObject([{ domain: ['api.a.com'] }]);
    expect(rules[0]!.approval).toBeUndefined();
  });

  test('approval config: a bad approval.each is rejected', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", approval={each=bogus})
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /approval\.each must be one of/.test(e.message))).toBe(true);
  });

  test('approval config: an unknown approval option is rejected', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", approval={eech=request})
      API_KEY=secret
    `);
    const errors = graph.configSchema.API_KEY.decoratorSchemaErrors;
    expect(errors.some((e) => /unknown approval option "eech"/.test(e.message))).toBe(true);
  });

  test('@proxy=passthrough / =omit parse as value-form modes (no rule created)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @sensitive
      # @proxy=passthrough
      PASS_KEY=real-value

      # @sensitive
      # @proxy=omit
      OMIT_KEY=real-value
    `);

    expect(graph.configSchema.PASS_KEY.getDec('proxy')?.resolvedValue).toBe('passthrough');
    expect(graph.configSchema.OMIT_KEY.getDec('proxy')?.resolvedValue).toBe('omit');
    // value-form @proxy does not create a routing rule
    expect(await graph.getProxyRules()).toEqual([]);
  });

  test('mixing @proxy=value and @proxy(...) on one item is an error', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @sensitive
      # @proxy=passthrough
      # @proxy(domain="api.x.com")
      MIXED=secret
    `);

    const errors = graph.configSchema.MIXED.decoratorSchemaErrors;
    expect(errors.some((e) => /both a value .* and a function/.test(e.message))).toBe(true);
  });

  test('@proxy=<invalid> is rejected', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy=nonsense
      BAD=secret
    `);

    const errors = graph.configSchema.BAD.decoratorSchemaErrors;
    expect(errors.some((e) => /must be "passthrough" or "omit"/.test(e.message))).toBe(true);
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

    // Explicit @placeholder wins; @type constraints derive a format-shaped
    // placeholder honoring startsWith + isLength, while staying unique.
    expect(byKey.EXPLICIT_KEY?.placeholder).toBe('sk_test_explicit');
    expect(byKey.TYPE_KEY?.placeholder).toMatch(/^tok_[0-9a-f]{8}$/);
    expect(byKey.TYPE_KEY?.placeholder).toHaveLength(12);
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

describe('proxy resolution view (proxied re-resolution)', () => {
  // Build a graph but apply a proxy view BEFORE resolving, mimicking a proxied
  // child re-running `varlock load`/`printenv`. The real value must never surface.
  async function loadWithView(
    envFile: string,
    view: NonNullable<EnvGraph['proxyResolutionView']>,
  ) {
    const graph = new EnvGraph();
    const source = new DotEnvFileDataSource('.env.schema', { overrideContents: envFile });
    await graph.setRootDataSource(source);
    await graph.finishLoad();
    graph.proxyResolutionView = view;
    await graph.resolveEnvValues();
    return graph;
  }

  test('forces a placeholder for a sensitive item and skips coerce/validate', async () => {
    const graph = await loadWithView(
      outdent`
        # ---
        # @sensitive @type=number
        NUM_SECRET=42
      `,
      { NUM_SECRET: { kind: 'placeholder', value: 'vlk_placeholder_NUM_SECRET_abcd1234' } },
    );

    const item = graph.configSchema.NUM_SECRET;
    // A non-numeric placeholder is accepted verbatim — no coercion/validation error,
    // because the real value was already validated upstream by the proxy daemon.
    expect(item.resolvedValue).toBe('vlk_placeholder_NUM_SECRET_abcd1234');
    expect(item.coercionError).toBeUndefined();
    expect(item.validationErrors).toBeUndefined();
    // and the real value is gone
    expect(graph.getResolvedEnvObject().NUM_SECRET).not.toBe(42);
  });

  test('omits an item to undefined without tripping the required check', async () => {
    const graph = await loadWithView(
      outdent`
        # ---
        # @sensitive @required
        REQ_SECRET=real-secret
      `,
      { REQ_SECRET: { kind: 'omit' } },
    );

    const item = graph.configSchema.REQ_SECRET;
    expect(item.resolvedValue).toBeUndefined();
    expect(item.validationErrors).toBeUndefined();
  });
});

// A single-use object-value decorator called as `@name(...)` is guided toward the
// object form. The per-decorator wording is driven by the decorator def
// (`objectValueExample`), not by names hardcoded in the shared handler — so the
// same generic path serves a root decorator (@proxyConfig) and an item one (@sensitive).
describe('single-use object-value decorators point at the object form', () => {
  test('a bare `@proxyConfig()` (root) suggests the def\'s example options', async () => {
    const graph = await loadGraph(outdent`
      # @proxyConfig()
      # ---
      FOO=1
    `);
    const errors = graph.sortedDataSources.flatMap((s) => s.errors);
    expect(errors.some((e) => /@proxyConfig is single-use and cannot be called like @proxyConfig\(\.\.\.\)\. To pass options, use an object value: @proxyConfig=\{egress="strict"\}/.test(e.message))).toBe(true);
  });

  test('a bare `@sensitive()` (item) suggests its own example via the same generic path', async () => {
    const graph = await loadGraph(outdent`
      # ---
      # @sensitive()
      SECRET=x
    `);
    const errors = graph.configSchema.SECRET.decoratorSchemaErrors;
    expect(errors.some((e) => /@sensitive is single-use and cannot be called like @sensitive\(\.\.\.\)\. To pass options, use an object value: @sensitive=\{preventLeaks=false\}/.test(e.message))).toBe(true);
  });

  test('provided options are echoed back (not the example)', async () => {
    const graph = await loadGraph(outdent`
      # @proxyConfig(egress="permissive")
      # ---
      FOO=1
    `);
    const errors = graph.sortedDataSources.flatMap((s) => s.errors);
    expect(errors.some((e) => /use an object value: @proxyConfig=\{egress="permissive"\}/.test(e.message))).toBe(true);
  });
});
