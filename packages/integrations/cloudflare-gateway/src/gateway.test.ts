import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import type { ProxyActivity } from 'varlock/proxy-core';

import { createVarlockGateway, GATEWAY_TARGET_HEADER, GATEWAY_TOKEN_HEADER } from './gateway';

const PLACEHOLDER = 'vlk-placeholder-stripe-abc123';
const REAL_VALUE = 'sk_live_real_secret_value_9876';
const TOKEN = 'test-data-plane-token';

const ENV = {
  STRIPE_KEY: REAL_VALUE,
  _VARLOCK_GATEWAY_TOKEN: TOKEN,
};

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    rules: [{ domain: ['api.stripe.com'], itemKeys: ['STRIPE_KEY'] }],
    placeholders: { STRIPE_KEY: PLACEHOLDER },
    ...overrides,
  };
}

/** Captures upstream fetch calls and returns a canned response. */
function stubUpstream(response?: () => Response) {
  const calls: Array<{ url: string; init: RequestInit & { headers: Headers } }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: { ...init, headers: new Headers(init?.headers) } });
    if (response) return response();
    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': '2' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('asSandboxOutbound (transparent mode)', () => {
  test('substitutes a placeholder in an auth header and forwards to the original URL', async () => {
    const calls = stubUpstream();
    const activities: Array<ProxyActivity> = [];
    const gateway = createVarlockGateway(baseConfig({ onAudit: (a: ProxyActivity) => activities.push(a) }));
    const handler = gateway.asSandboxOutbound();

    const res = await handler(new Request('https://api.stripe.com/v1/charges', {
      method: 'POST',
      headers: { authorization: `Bearer ${PLACEHOLDER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 100 }),
    }), ENV);

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/charges');
    expect(calls[0].init.headers.get('authorization')).toBe(`Bearer ${REAL_VALUE}`);
    expect(activities).toMatchObject([{ decision: 'allow', matched: true, injectedKeys: ['STRIPE_KEY'] }]);
  });

  test('strict egress blocks a host with no rule', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig({ egressMode: 'strict' })).asSandboxOutbound();

    const res = await handler(new Request('https://evil.example.com/exfil'), ENV);

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('not allowed by your egress policy');
    expect(calls).toHaveLength(0);
  });

  test('default (permissive) egress forwards unruled hosts untouched', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asSandboxOutbound();

    const res = await handler(new Request('https://example.com/data?q=1'), ENV);

    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://example.com/data?q=1');
  });

  test('blocks a placeholder placed in the query (location guard)', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asSandboxOutbound();

    const res = await handler(new Request(`https://api.stripe.com/v1/charges?key=${PLACEHOLDER}`), ENV);

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('appears in the query');
    expect(calls).toHaveLength(0);
  });

  test('blocks a duplicated placeholder (occurrence cap)', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asSandboxOutbound();

    const res = await handler(new Request('https://api.stripe.com/v1/charges', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${PLACEHOLDER}`,
        'x-echo': PLACEHOLDER,
      },
    }), ENV);

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('at most 1 is allowed');
    expect(calls).toHaveLength(0);
  });

  test('refuses to inject over cleartext http', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asSandboxOutbound();

    const res = await handler(new Request('http://api.stripe.com/v1/charges', {
      method: 'POST',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    }), ENV);

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('cleartext');
    expect(calls).toHaveLength(0);
  });

  test('fails closed when a carried placeholder has no secret value', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asSandboxOutbound();

    const res = await handler(new Request('https://api.stripe.com/v1/charges', {
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    }), { /* no STRIPE_KEY binding */ });

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('no value available for STRIPE_KEY');
    expect(calls).toHaveLength(0);
  });

  test('forwards a request that does not carry the placeholder even when the secret is unavailable', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asSandboxOutbound();

    const res = await handler(new Request('https://api.stripe.com/v1/status'), {});

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test('scrubs a reflected secret out of a buffered response body', async () => {
    const body = JSON.stringify({ note: `your key is ${REAL_VALUE}` });
    stubUpstream(() => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    }));
    const handler = createVarlockGateway(baseConfig()).asSandboxOutbound();

    const res = await handler(new Request('https://api.stripe.com/v1/charges', {
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    }), ENV);

    const text = await res.text();
    expect(text).toContain(PLACEHOLDER);
    expect(text).not.toContain(REAL_VALUE);
  });

  test('scrubs a reflected secret out of a streamed SSE response, across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    // split the real value across two chunks to exercise the hold-back logic
    const part1 = `data: your key is ${REAL_VALUE.slice(0, 10)}`;
    const part2 = `${REAL_VALUE.slice(10)}\n\n`;
    stubUpstream(() => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(part1));
          controller.enqueue(encoder.encode(part2));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    const responses: Array<{ scrubbedKeys: Array<string>; streamed?: boolean }> = [];
    const handler = createVarlockGateway(baseConfig({
      onResponse: (info: any) => responses.push(info),
    })).asSandboxOutbound();

    const res = await handler(new Request('https://api.stripe.com/v1/charges', {
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    }), ENV);

    const text = await res.text();
    expect(text).toBe(`data: your key is ${PLACEHOLDER}\n\n`);
    expect(responses).toMatchObject([{ scrubbedKeys: ['STRIPE_KEY'], streamed: true }]);
  });

  test('creation throws when a rule requires approval (no provider in tier 0)', () => {
    expect(() => createVarlockGateway(baseConfig({
      rules: [{ domain: ['api.stripe.com'], itemKeys: ['STRIPE_KEY'], approval: {} }],
    }))).toThrow(/approval provider/);
  });
});

describe('asFetchHandler (explicit gateway mode)', () => {
  function gatewayRequest(opts: {
    token?: string | null;
    target?: string | null;
    path?: string;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
  } = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token !== null) headers[GATEWAY_TOKEN_HEADER] = opts.token ?? TOKEN;
    if (opts.target !== null) headers[GATEWAY_TARGET_HEADER] = opts.target ?? 'api.stripe.com';
    return new Request(`https://gateway.example.workers.dev${opts.path ?? '/v1/charges'}`, {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body ? { body: opts.body } : {}),
    });
  }

  test('refuses everything when no token is configured', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asFetchHandler();

    const res = await handler(gatewayRequest(), { STRIPE_KEY: REAL_VALUE });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('no data-plane token configured');
    expect(calls).toHaveLength(0);
  });

  test('rejects a missing or wrong token', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asFetchHandler();

    expect((await handler(gatewayRequest({ token: null }), ENV)).status).toBe(401);
    expect((await handler(gatewayRequest({ token: 'wrong' }), ENV)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('accepts the token via Proxy-Authorization basic auth', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asFetchHandler();

    const res = await handler(gatewayRequest({
      token: null,
      headers: { 'proxy-authorization': `Basic ${btoa(`varlock:${TOKEN}`)}` },
    }), ENV);

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test('requires and validates the target header', async () => {
    stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asFetchHandler();

    expect((await handler(gatewayRequest({ target: null }), ENV)).status).toBe(400);
    expect((await handler(gatewayRequest({ target: 'not a host!' }), ENV)).status).toBe(400);
  });

  test('substitutes and forwards to the target host, stripping gateway-internal headers', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig()).asFetchHandler();

    const res = await handler(gatewayRequest({
      method: 'POST',
      path: '/v1/charges?expand=balance',
      headers: { authorization: `Bearer ${PLACEHOLDER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 100 }),
    }), ENV);

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/charges?expand=balance');
    const sent = calls[0].init.headers;
    expect(sent.get('authorization')).toBe(`Bearer ${REAL_VALUE}`);
    expect(sent.get(GATEWAY_TARGET_HEADER)).toBeNull();
    expect(sent.get(GATEWAY_TOKEN_HEADER)).toBeNull();
    expect(sent.get('proxy-authorization')).toBeNull();
  });

  test('honors a non-default target port', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig({
      rules: [{ domain: ['internal.example.com'], itemKeys: [] }],
    })).asFetchHandler();

    const res = await handler(gatewayRequest({ target: 'internal.example.com:8443', path: '/ping' }), ENV);

    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://internal.example.com:8443/ping');
  });

  test('blocks an uninjected placeholder with a helpful error', async () => {
    const calls = stubUpstream();
    const handler = createVarlockGateway(baseConfig({
      rules: [
        { domain: ['api.stripe.com'], itemKeys: ['STRIPE_KEY'] },
        { domain: ['other.example.com'], itemKeys: [] },
      ],
    })).asFetchHandler();

    const res = await handler(gatewayRequest({
      target: 'other.example.com',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    }), ENV);

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('no @proxy rule injects it here');
    expect(calls).toHaveLength(0);
  });
});
