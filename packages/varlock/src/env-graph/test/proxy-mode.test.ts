import {
  beforeEach, describe, expect, test, vi,
} from 'vitest';
import path from 'node:path';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';

// relative @plugin(...) paths resolve against cwd - pin it to this test dir
beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(path.dirname(expect.getState().testPath!));
});

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

  test('attached transform: secretKey defaults to the item, is excluded from substitution scope, keyId joins the rule', async () => {
    const graph = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.coinbase.com", transform={
      #   scheme="hmac-sha256", stringToSign="{timestamp}{method}{pathWithQuery}{body}",
      #   signatureHeader="CB-ACCESS-SIGN", timestampHeader="CB-ACCESS-TIMESTAMP",
      #   keyId=$CB_KEY_ID, keyHeader="CB-ACCESS-KEY", encoding="hex",
      # })
      CB_SECRET=shhh-real

      # @sensitive
      CB_KEY_ID=kid-real
    `);

    const rules = await graph.getProxyRules();
    expect(rules).toMatchObject([
      {
        domain: ['api.coinbase.com'],
        // The signing secret is consumed, never substituted, so it is NOT in the
        // rule's substitution scope even though the rule is attached to it. The
        // key id IS wire-visible, so it joins like a keys= entry.
        itemKeys: ['CB_KEY_ID'],
        transform: {
          scheme: 'hmac-sha256',
          secretKey: { itemRef: 'CB_SECRET' },
          stringToSign: '{timestamp}{method}{pathWithQuery}{body}',
          signatureHeader: 'CB-ACCESS-SIGN',
          timestampHeader: 'CB-ACCESS-TIMESTAMP',
          keyId: { itemRef: 'CB_KEY_ID' },
          keyHeader: 'CB-ACCESS-KEY',
          encoding: 'hex',
        },
      },
    ]);

    // Both transform roles become managed items (placeholder in the child env,
    // real value withheld) - the secret via the transform, the key id via itemKeys.
    const managed = await graph.getProxyManagedItems();
    const managedByKey = Object.fromEntries(managed.map((item) => [item.key, item]));
    expect(managedByKey.CB_SECRET?.realValue).toBe('shhh-real');
    expect(managedByKey.CB_KEY_ID?.realValue).toBe('kid-real');
  });

  test('detached transform rule with explicit secretKey manages the item with no per-item @proxy at all', async () => {
    const graph = await loadGraph(outdent`
      # @proxy(domain="api.partner.com", transform={
      #   scheme="hmac-sha256", stringToSign="{body}", signatureHeader="X-Signature", secretKey=$HOOK_SECRET,
      # })
      # ---
      # @sensitive
      HOOK_SECRET=hook-real
    `);

    const rules = await graph.getProxyRules();
    expect(rules).toMatchObject([{ domain: ['api.partner.com'], itemKeys: [], transform: { scheme: 'hmac-sha256', secretKey: { itemRef: 'HOOK_SECRET' } } }]);
    const managed = await graph.getProxyManagedItems();
    expect(managed.map((item) => item.key)).toContain('HOOK_SECRET');
  });

  test('detached transform without secretKey is rejected (no attached item to default to)', async () => {
    const graph = await loadGraph(outdent`
      # @proxy(domain="api.partner.com", transform={scheme="hmac-sha256", stringToSign="{body}", signatureHeader="X-Signature"})
      # ---
      BASELINE=1
    `);
    await expect(graph.getProxyRules()).rejects.toThrow(/transform\.secretKey is required on a detached @proxy rule/);
  });

  test('transform: unknown option and bad scheme fail loudly at load time', async () => {
    const unknownOpt = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", transform={scheme="hmac-sha256", stringToSine="{body}", signatureHeader="X-Sig"})
      API_SECRET=shhh
    `);
    expect(unknownOpt.configSchema.API_SECRET.decoratorSchemaErrors.some((e) => /unknown transform option "stringToSine"/.test(e.message))).toBe(true);

    // An unknown scheme can't be judged statically (it may come from a plugin
    // that only registers at load), so it fails at resolve time instead.
    const badScheme = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", transform={scheme="md5", stringToSign="{body}", signatureHeader="X-Sig"})
      API_SECRET=shhh
    `);
    await expect(badScheme.getProxyRules()).rejects.toThrow(/unknown transform scheme "md5"/);
  });

  test('transform: a forbidden header target is rejected (framing/identity headers)', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", transform={scheme="hmac-sha256", stringToSign="{body}", signatureHeader="content-length"})
      API_SECRET=shhh
    `);
    expect(graph.configSchema.API_SECRET.decoratorSchemaErrors.some((e) => /cannot target the "content-length" header/.test(e.message))).toBe(true);
  });

  test('http-basic: the decorated item fills the side left unset (userid when neither is given)', async () => {
    // neither given: the item is the userid with an empty password
    // (curl -u "token:", the single-credential Basic convention)
    const bare = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.stripe.com", transform={scheme="http-basic"})
      STRIPE_SECRET_KEY=sk_live_real
    `);
    expect(await bare.getProxyRules()).toMatchObject([{ transform: { scheme: 'http-basic', username: { itemRef: 'STRIPE_SECRET_KEY' } } }]);

    // username given: the item is the password
    const withUsername = await loadGraph(outdent`
      # ---
      # @proxy(domain="registry.example.com", transform={scheme="http-basic", username="ci-bot"})
      REGISTRY_PASSWORD=real-password
    `);
    expect(await withUsername.getProxyRules()).toMatchObject([{ transform: { scheme: 'http-basic', username: 'ci-bot', password: { itemRef: 'REGISTRY_PASSWORD' } } }]);

    // password given (a literal): the item is the userid (GitHub style)
    const withPassword = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.github.com", transform={scheme="http-basic", password="x-oauth-basic"})
      GH_TOKEN=the-token
    `);
    expect(await withPassword.getProxyRules()).toMatchObject([{ transform: { scheme: 'http-basic', username: { itemRef: 'GH_TOKEN' }, password: 'x-oauth-basic' } }]);

    // an explicitly empty userid pushes the item to the password side
    const emptyUsername = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.legacy.com", transform={scheme="http-basic", username=""})
      LEGACY_PASSWORD=real-password
    `);
    expect(await emptyUsername.getProxyRules()).toMatchObject([{ transform: { scheme: 'http-basic', username: '', password: { itemRef: 'LEGACY_PASSWORD' } } }]);
  });

  test('http-basic: both sides can be references, and both become consumed credentials', async () => {
    const graph = await loadGraph(outdent`
      # @proxy(domain="api.twilio.com", transform={
      #   scheme="http-basic", username=$TWILIO_SID, password=$TWILIO_AUTH_TOKEN,
      # })
      # ---
      # @sensitive
      TWILIO_SID=the-sid
      # @sensitive
      TWILIO_AUTH_TOKEN=the-token
    `);
    const rules = await graph.getProxyRules();
    expect(rules).toMatchObject([
      {
        // neither is substitutable: both are consumed by the signer
        itemKeys: [],
        transform: { scheme: 'http-basic', username: { itemRef: 'TWILIO_SID' }, password: { itemRef: 'TWILIO_AUTH_TOKEN' } },
      },
    ]);
    // both are managed (placeholder in the child env), values never in rule data
    const managed = await graph.getProxyManagedItems();
    expect(managed.map((item) => item.key).sort()).toEqual(['TWILIO_AUTH_TOKEN', 'TWILIO_SID']);
    expect(JSON.stringify(rules)).not.toContain('the-sid');
    expect(JSON.stringify(rules)).not.toContain('the-token');
  });

  test('getTransformRoleKeys reports credentials per scheme shape (what `proxy rules` renders)', async () => {
    const graph = await loadGraph(outdent`
      # @proxy(domain="api.twilio.com", transform={
      #   scheme="http-basic", username=$TWILIO_SID, password=$TWILIO_TOKEN,
      # })
      # ---
      # @proxy(domain="api.stripe.com", transform={scheme="http-basic"})
      STRIPE_KEY=sk_live_fake

      # @proxy(domain="api.exchange.com", transform={
      #   scheme="hmac-sha256", stringToSign="{body}", signatureHeader="X-Sig",
      #   keyId=$EXCHANGE_KEY_ID, keyHeader="X-Key",
      # })
      EXCHANGE_SECRET=shhh

      # @sensitive
      TWILIO_SID=ACfake
      # @sensitive
      TWILIO_TOKEN=tokfake
      # @sensitive
      EXCHANGE_KEY_ID=key-id
    `);
    const rules = await graph.getProxyRules();
    const consumedByDomain = Object.fromEntries(rules.map((rule) => [
      rule.domain[0],
      graph.getTransformRoleKeys(rule.transform!, 'consumed').sort(),
    ]));
    expect(consumedByDomain).toEqual({
      // both http-basic sides are credentials
      'api.twilio.com': ['TWILIO_SID', 'TWILIO_TOKEN'],
      // attached, neither side given: the decorated item is the userid
      'api.stripe.com': ['STRIPE_KEY'],
      // hmac: only the secret is consumed (keyId is wire-visible)
      'api.exchange.com': ['EXCHANGE_SECRET'],
    });
    // the wire-role keyId is substitutable, the consumed secrets are not
    const exchangeRule = rules.find((rule) => rule.domain[0] === 'api.exchange.com');
    expect(exchangeRule?.itemKeys).toEqual(['EXCHANGE_KEY_ID']);
  });

  test('http-basic: a detached rule needs at least one credential reference', async () => {
    const noCredential = await loadGraph(outdent`
      # @proxy(domain="registry.example.com", transform={scheme="http-basic", username="ci-bot"})
      # ---
      BASELINE=1
    `);
    await expect(noCredential.getProxyRules()).rejects.toThrow(/transform needs a credential/);

    // the generic secretKey name is not part of this scheme's surface
    const secretKeyName = await loadGraph(outdent`
      # @proxy(domain="registry.example.com", transform={scheme="http-basic", secretKey=$REGISTRY_PASSWORD})
      # ---
      # @sensitive
      REGISTRY_PASSWORD=real-password
    `);
    await expect(secretKeyName.getProxyRules()).rejects.toThrow(/unknown transform option "secretKey" for scheme "http-basic"/);
  });

  test('credential options require $ references, and a broken reference fails loudly', async () => {
    // hmac's secretKey is ref-only: a literal there is a credential embedded in
    // the schema, caught at load for built-in schemes
    const literalSecret = await loadGraph(outdent`
      # @proxy(domain="api.a.com", transform={
      #   scheme="hmac-sha256", stringToSign="{body}", signatureHeader="X-Sig", secretKey="hunter2",
      # })
      # ---
      BASELINE=1
    `);
    const loadErrors = (literalSecret.rootDataSource?.schemaErrors ?? []).map((err) => err.message);
    expect(loadErrors.some((msg) => /transform\.secretKey must be a reference to a config item/.test(msg))).toBe(true);

    // plugin schemes are unknown to the load-time pass, so the same rule is
    // enforced when rules are built
    const pluginLiteral = await loadGraph(outdent`
      # @plugin(./plugins/test-transform-plugin)
      # ---
      # @proxy(domain="api.a.com", transform={scheme="test-sign", tokenId="tok-literal", signatureHeader="X-Sig"})
      SIGNING_SECRET=shhh
    `);
    await expect(pluginLiteral.getProxyRules()).rejects.toThrow(/transform\.tokenId must be a reference to a config item/);

    // a reference to a nonexistent item is an ordinary unresolved reference
    const missingItem = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.a.com", transform={scheme="http-basic", password=$NO_SUCH_ITEM})
      BASELINE=1
    `);
    const refErrors = missingItem.configSchema.BASELINE.decoratorSchemaErrors.map((err) => err.message);
    expect(refErrors.some((msg) => /NO_SUCH_ITEM/.test(msg))).toBe(true);
    // and no half-built rule escapes
    expect(await missingItem.getProxyRules()).toEqual([]);
  });

  test('transform: literal options may interpolate config, but not a sensitive value', async () => {
    // non-sensitive config interpolates fine (items are sensitive by default,
    // so this is opt-in via @sensitive=false)
    const interpolatedUsername = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.a.com", transform={scheme="http-basic", username="acct-\${ACCOUNT_ID}"})
      API_PASSWORD=real-password

      # @sensitive=false
      ACCOUNT_ID=acct123
    `);
    expect(await interpolatedUsername.getProxyRules()).toMatchObject([{ transform: { username: 'acct-acct123', password: { itemRef: 'API_PASSWORD' } } }]);

    // interpolating a SECRET would put its value in the rule, bypassing the
    // reference mechanism entirely
    const interpolatedSecret = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.b.com", transform={
      #   scheme="http-basic", username=$USER_NAME, password="pre-\${LEAKY_SECRET}",
      # })
      BASELINE=1

      USER_NAME=bob
      # @sensitive
      LEAKY_SECRET=s3cr3t-value
    `);
    await expect(interpolatedSecret.getProxyRules()).rejects.toThrow(
      /transform\.password interpolates "LEAKY_SECRET"/,
    );
  });

  test('transform: two roles cannot reference the same item, and two options cannot write the same header', async () => {
    // keyId is sent upstream while secretKey is consumed; pointing both at one
    // item would put the signing secret on the wire
    const roleCollision = await loadGraph(outdent`
      # @proxy(domain="api.a.com", transform={
      #   scheme="hmac-sha256", stringToSign="{body}", signatureHeader="X-Sig",
      #   secretKey=$API_SECRET, keyId=$API_SECRET, keyHeader="X-Key",
      # })
      # ---
      # @sensitive
      API_SECRET=shhh
    `);
    await expect(roleCollision.getProxyRules()).rejects.toThrow(/both reference "API_SECRET"/);

    // a second write to the signature's header would silently overwrite it
    const headerCollision = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.a.com", transform={
      #   scheme="hmac-sha256", stringToSign="{timestamp}{body}", signatureHeader="X-Sig",
      #   timestampHeader="x-sig",
      # })
      API_SECRET=shhh
    `);
    await expect(headerCollision.getProxyRules()).rejects.toThrow(/both write the "x-sig" header/);
  });

  test('transform: {timestamp} in stringToSign requires a timestampHeader', async () => {
    const graph = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.a.com", transform={scheme="hmac-sha256", stringToSign="{timestamp}{body}", signatureHeader="X-Sig"})
      API_SECRET=shhh
    `);
    await expect(graph.getProxyRules()).rejects.toThrow(/uses \{timestamp\} but no timestampHeader/);
  });

  test('transform: an unknown {field} in stringToSign is rejected', async () => {
    const graph = await loadGraph(outdent`
      # @defaultSensitive=false
      # ---
      # @proxy(domain="api.a.com", transform={scheme="hmac-sha256", stringToSign="{timestamp}{nonce}", signatureHeader="X-Sig"})
      API_SECRET=shhh
    `);
    expect(graph.configSchema.API_SECRET.decoratorSchemaErrors.some((e) => /unknown field \{nonce\}/.test(e.message))).toBe(true);
  });

  test('transform: keyId and keyHeader must be set together', async () => {
    const graph = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.a.com", transform={scheme="hmac-sha256", stringToSign="{body}", signatureHeader="X-Sig", keyId=$SOME_KEY_ID})
      API_SECRET=shhh

      SOME_KEY_ID=kid
    `);
    await expect(graph.getProxyRules()).rejects.toThrow(/keyId and transform\.keyHeader must be set together/);
  });

  test('transform: missing required fields are rejected at resolve time', async () => {
    const graph = await loadGraph(outdent`
      # ---
      # @proxy(domain="api.a.com", transform={scheme="hmac-sha256", signatureHeader="X-Sig"})
      API_SECRET=shhh
    `);
    await expect(graph.getProxyRules()).rejects.toThrow(/transform\.stringToSign is required/);
  });

  test('plugin transform scheme: registers, roles drive itemKeys + managed items, lists normalize', async () => {
    // (cwd is mocked to this test dir so the relative @plugin path resolves)
    const graph = await loadGraph(outdent`
      # @plugin(./plugins/test-transform-plugin)
      # ---
      # @proxy(domain="api.example.com", transform={
      #   scheme="test-sign", tokenId=$TOKEN_ID, signatureHeader="X-Test-Sig",
      #   mode="fancy", allowedThings="one",
      # })
      SIGNING_SECRET=shhh-real

      # @sensitive
      TOKEN_ID=tok-real
    `);

    const rules = await graph.getProxyRules();
    expect(rules).toMatchObject([
      {
        domain: ['api.example.com'],
        // wire-role tokenId joins; consumed-role secret is excluded
        itemKeys: ['TOKEN_ID'],
        transform: {
          scheme: 'test-sign',
          secretKey: { itemRef: 'SIGNING_SECRET' },
          tokenId: { itemRef: 'TOKEN_ID' },
          signatureHeader: 'X-Test-Sig',
          mode: 'fancy',
          allowedThings: ['one'], // single string normalized to a list
        },
      },
    ]);
    const managed = await graph.getProxyManagedItems();
    expect(managed.map((item) => item.key).sort()).toEqual(['SIGNING_SECRET', 'TOKEN_ID']);
  });

  test('plugin transform scheme: spec-driven validation (required, enum, unknown option)', async () => {
    const missingRequired = await loadGraph(outdent`
      # @plugin(./plugins/test-transform-plugin)
      # ---
      # @proxy(domain="api.example.com", transform={scheme="test-sign", signatureHeader="X-Test-Sig"})
      SIGNING_SECRET=shhh
    `);
    await expect(missingRequired.getProxyRules()).rejects.toThrow(/transform\.tokenId is required for scheme "test-sign"/);

    const badEnum = await loadGraph(outdent`
      # @plugin(./plugins/test-transform-plugin)
      # ---
      # @proxy(domain="api.example.com", transform={scheme="test-sign", tokenId=$TOKEN_ID, signatureHeader="X-Test-Sig", mode="bogus"})
      SIGNING_SECRET=shhh

      # @sensitive
      TOKEN_ID=tok
    `);
    await expect(badEnum.getProxyRules()).rejects.toThrow(/transform\.mode must be one of plain, fancy/);

    const unknownOption = await loadGraph(outdent`
      # @plugin(./plugins/test-transform-plugin)
      # ---
      # @proxy(domain="api.example.com", transform={scheme="test-sign", tokenId=$TOKEN_ID, signatureHeader="X-Test-Sig", stringToSign="{body}"})
      SIGNING_SECRET=shhh

      # @sensitive
      TOKEN_ID=tok
    `);
    await expect(unknownOption.getProxyRules()).rejects.toThrow(/unknown transform option "stringToSign" for scheme "test-sign"/);
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

  test('still computes isDynamic from decorators for a proxy-view item', async () => {
    // processDynamic reads only decorators (no value resolver), so it must run even
    // under a proxy view - otherwise a @sensitive @static item stays wrongly dynamic
    const graph = await loadWithView(
      outdent`
        # ---
        # @sensitive @static
        STATIC_SECRET=real-secret
      `,
      { STATIC_SECRET: { kind: 'placeholder', value: 'vlk_placeholder_STATIC_SECRET_abcd' } },
    );

    const item = graph.configSchema.STATIC_SECRET;
    expect(item.isSensitive).toBe(true);
    expect(item.isDynamic).toBe(false);
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
