import { describe, expect, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { URL } from 'node:url';

import type { ProxyActivity } from './audit';
import {
  checkSubstitutionGuards, findUninjectedPlaceholder, replacePlaceholdersWithReal, startLocalProxyRuntime,
  type SubstitutionGuardRequest,
} from './runtime-proxy';
import type { RequestScopedManagedItem } from './policy';

/** Bind an ephemeral port, capture it, release it — a free port for a fixed-port test. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

describe('findUninjectedPlaceholder (helpful-failure guard)', () => {
  const items = [
    { key: 'A', placeholder: 'vlk_ph_A', realValue: 'RA' },
    { key: 'B', placeholder: 'vlk_ph_B', realValue: 'RB' },
  ] as any;

  test('flags a placeholder present in the request that is NOT injected here', () => {
    // A is being injected on this route; B's placeholder is present but not injected.
    const found = findUninjectedPlaceholder(['authorization: Bearer vlk_ph_B'], items, [items[0]]);
    expect(found?.key).toBe('B');
  });

  test('does not flag a placeholder that WILL be injected on this route', () => {
    expect(findUninjectedPlaceholder(['Bearer vlk_ph_A'], items, [items[0]])).toBeUndefined();
  });

  test('does not flag a request with no managed placeholder (permissive passthrough stays clean)', () => {
    expect(findUninjectedPlaceholder(['authorization: Bearer sk-users-own-key'], items, [])).toBeUndefined();
  });

  test('scans all parts (target, headers, body) and ignores empty placeholders', () => {
    const withEmpty = [...items, { key: 'C', placeholder: '', realValue: 'RC' }] as any;
    expect(findUninjectedPlaceholder(['/p', '{}', 'body has vlk_ph_A'], withEmpty, [])?.key).toBe('A');
  });
});

describe('replacePlaceholdersWithReal', () => {
  test('substitutes the longest placeholder first so substring placeholders are not corrupted', () => {
    // P1 is a prefix of P2 — naive left-to-right replacement would splice R1 into
    // P2's text and never match P2 correctly.
    const managedItems = [
      { key: 'A', placeholder: 'vlk_x', realValue: 'REAL_A' },
      { key: 'B', placeholder: 'vlk_x_1', realValue: 'REAL_B' },
    ];
    const input = 'a=vlk_x&b=vlk_x_1';
    expect(replacePlaceholdersWithReal(input, managedItems as any)).toBe('a=REAL_A&b=REAL_B');
  });
});

describe('checkSubstitutionGuards', () => {
  const emptyReq: SubstitutionGuardRequest = {
    headers: [], requestTarget: '/', body: '', contentType: undefined,
  };
  const item = (over: Partial<RequestScopedManagedItem> = {}): RequestScopedManagedItem => ({
    key: 'API_KEY',
    placeholder: 'vlk_ph_key',
    realValue: 'sk-real',
    targets: [{ location: 'header' }],
    maxOccurrences: 1,
    ...over,
  });
  const jsonBody = (obj: unknown): Partial<SubstitutionGuardRequest> => ({
    body: JSON.stringify(obj), contentType: 'application/json',
  });

  test('allows a placeholder in an allowed header within the occurrence cap', () => {
    const req = { ...emptyReq, headers: [{ name: 'authorization', value: 'Bearer vlk_ph_key' }] };
    expect(checkSubstitutionGuards(req, [item()])).toBeUndefined();
  });

  test('blocks a placeholder in the body under the any-header default', () => {
    const req = { ...emptyReq, ...jsonBody({ note: 'vlk_ph_key' }) };
    expect(checkSubstitutionGuards(req, [item()])).toMatchObject({ kind: 'location', location: 'body' });
  });

  test('allows a body placeholder only at the exact path it was widened to', () => {
    const req = { ...emptyReq, ...jsonBody({ client_secret: 'vlk_ph_key' }) };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: 'client_secret' }] })])).toBeUndefined();
  });

  test('blocks a body placeholder at a DIFFERENT path than the one allowed (the exfil case)', () => {
    // body:client_secret is allowed, but the agent put the placeholder in `note`
    // instead — a path-level guard catches this; a coarse "body" bucket would not.
    const req = { ...emptyReq, ...jsonBody({ note: 'vlk_ph_key' }) };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: 'client_secret' }] })]))
      .toMatchObject({ kind: 'location', location: 'body' });
  });

  test('the any-header default excludes denylisted forward/log headers (cookie, x-forwarded-*, ...)', () => {
    // Placeholder redirected into a header the upstream might forward/log — blocked
    // even though the item allows "any header".
    for (const name of ['cookie', 'x-forwarded-for', 'host', 'referer', 'user-agent']) {
      const req = { ...emptyReq, headers: [{ name, value: 'x vlk_ph_key y' }] };
      expect(checkSubstitutionGuards(req, [item()])).toMatchObject({ kind: 'location', location: 'header' });
    }
  });

  test('an explicit header:<name> target overrides the denylist', () => {
    const req = { ...emptyReq, headers: [{ name: 'cookie', value: 'session=vlk_ph_key' }] };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'header', name: 'cookie' }] })])).toBeUndefined();
  });

  test('pins to a specific header name', () => {
    const allowed = item({ targets: [{ location: 'header', name: 'authorization' }] });
    const inAuth = { ...emptyReq, headers: [{ name: 'authorization', value: 'Bearer vlk_ph_key' }] };
    expect(checkSubstitutionGuards(inAuth, [allowed])).toBeUndefined();
    const inOther = { ...emptyReq, headers: [{ name: 'x-evil', value: 'vlk_ph_key' }] };
    expect(checkSubstitutionGuards(inOther, [allowed])).toMatchObject({ kind: 'location', location: 'header' });
  });

  test('allows a placeholder in a named query param', () => {
    const req = { ...emptyReq, requestTarget: '/v1?api_key=vlk_ph_key' };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'query', name: 'api_key' }] })])).toBeUndefined();
    // ...but not in a different param
    const other = { ...emptyReq, requestTarget: '/v1?leak=vlk_ph_key' };
    expect(checkSubstitutionGuards(other, [item({ targets: [{ location: 'query', name: 'api_key' }] })]))
      .toMatchObject({ kind: 'location', location: 'query' });
  });

  test('blocks when a placeholder appears more times than the occurrence cap', () => {
    // Valid use in the header PLUS an exfil copy at the same body path (both allowed).
    const req = {
      ...emptyReq,
      headers: [{ name: 'authorization', value: 'Bearer vlk_ph_key' }],
      ...jsonBody({ client_secret: 'vlk_ph_key' }),
    };
    const allowed = item({ targets: [{ location: 'header' }, { location: 'body', path: 'client_secret' }] });
    expect(checkSubstitutionGuards(req, [allowed])).toMatchObject({ kind: 'occurrences', count: 2 });
  });

  test('allows repeated occurrences when maxOccurrences is raised', () => {
    const req = {
      ...emptyReq,
      headers: [{ name: 'authorization', value: 'Bearer vlk_ph_key' }],
      ...jsonBody({ client_secret: 'vlk_ph_key' }),
    };
    const allowed = item({ targets: [{ location: 'header' }, { location: 'body', path: 'client_secret' }], maxOccurrences: 2 });
    expect(checkSubstitutionGuards(req, [allowed])).toBeUndefined();
  });

  test('fails closed when a body:path target is set but the body cannot be parsed', () => {
    const req = { ...emptyReq, body: 'vlk_ph_key not-json', contentType: 'application/json' };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: 'client_secret' }] })]))
      .toMatchObject({ kind: 'location', location: 'body' });
  });

  test('body:* allows the placeholder anywhere in an unparseable (e.g. XML) body', () => {
    const xml = '<soap:Envelope><auth><token>vlk_ph_key</token></auth></soap:Envelope>';
    const req = { ...emptyReq, body: xml, contentType: 'application/xml' };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: '*' }] })])).toBeUndefined();
  });

  test('body:* still respects the occurrence cap', () => {
    // Two copies in an unstructured body — anywhere is allowed, but the default cap is 1.
    const req = { ...emptyReq, body: 'sig=vlk_ph_key&dup=vlk_ph_key', contentType: 'text/plain' };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: '*' }] })]))
      .toMatchObject({ kind: 'occurrences', count: 2 });
  });

  test('ignores items with an empty placeholder', () => {
    const req = { ...emptyReq, body: 'anything' };
    expect(checkSubstitutionGuards(req, [item({ placeholder: '' })])).toBeUndefined();
  });
});

async function requestViaProxy(proxyUrl: string, targetUrl: string, headers?: Record<string, string>) {
  const proxy = new URL(proxyUrl);
  return await new Promise<{
    statusCode: number;
    body: string;
    headers: http.IncomingHttpHeaders;
  }>((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'GET',
      path: targetUrl,
      headers,
    }, (res) => {
      const chunks: Array<Buffer> = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startLocalProxyRuntime', () => {
  test('returns proxy env vars and can be stopped', async () => {
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [],
      egressMode: 'permissive',
    });

    expect(runtime.env.HTTP_PROXY).toBeDefined();
    expect(runtime.env.HTTPS_PROXY).toBe(runtime.env.HTTP_PROXY);
    expect(runtime.env.ALL_PROXY).toBe(runtime.env.HTTP_PROXY);
    expect(runtime.env.http_proxy).toBe(runtime.env.HTTP_PROXY);
    expect(runtime.env.https_proxy).toBe(runtime.env.HTTP_PROXY);
    expect(runtime.env.all_proxy).toBe(runtime.env.HTTP_PROXY);

    expect(runtime.env.NODE_EXTRA_CA_CERTS).toBeDefined();
    expect(runtime.env.SSL_CERT_FILE).toBeDefined();
    expect(runtime.env.REQUESTS_CA_BUNDLE).toBeDefined();
    expect(runtime.env.CURL_CA_BUNDLE).toBeDefined();
    expect(runtime.env.GIT_SSL_CAINFO).toBeDefined();

    await runtime.stop();
  });

  test('blocks non-proxy domains in strict egress mode', async () => {
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [],
      egressMode: 'strict',
    });
    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://example.com/');
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('strict mode');
    await runtime.stop();
  });

  test('reconfigure() hot-swaps rules/egress on a live runtime', async () => {
    const upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to start upstream');
    const target = `http://127.0.0.1:${addr.port}/`;

    // Strict + no rules → the upstream host is not allowlisted → blocked.
    const runtime = await startLocalProxyRuntime({ managedItems: [], rules: [], egressMode: 'strict' });
    expect((await requestViaProxy(runtime.env.HTTP_PROXY!, target)).statusCode).toBe(403);

    // Reconfigure to allow 127.0.0.1 → the same request now reaches the upstream.
    runtime.reconfigure({
      managedItems: [],
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
      egressMode: 'strict',
    });
    const allowed = await requestViaProxy(runtime.env.HTTP_PROXY!, target);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toBe('ok');

    // Reconfigure back to no rules → blocked again (proves it's not one-way).
    runtime.reconfigure({ managedItems: [], rules: [], egressMode: 'strict' });
    expect((await requestViaProxy(runtime.env.HTTP_PROXY!, target)).statusCode).toBe(403);

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('refuses to inject a secret into a cleartext (http) connection (Invariant #2)', async () => {
    let upstreamGotRequest = false;
    let upstreamAuth = '';
    const upstream = http.createServer((req, res) => {
      upstreamGotRequest = true;
      upstreamAuth = String(req.headers.authorization ?? '');
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'PH_placeholder', realValue: 'sk-REAL-secret' }],
      rules: [{ domain: ['127.0.0.1'], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
    });

    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/`, {
      authorization: 'Bearer PH_placeholder',
    });

    // Fail closed: a ruled item over a cleartext connection is refused, and the
    // real secret never reaches the (un-TLS'd) upstream.
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('cleartext');
    expect(upstreamGotRequest).toBe(false);
    expect(upstreamAuth).not.toContain('sk-REAL-secret');

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('passes the client Accept-Encoding through unchanged', async () => {
    let receivedAcceptEncoding = '';
    const upstream = http.createServer((req, res) => {
      receivedAcceptEncoding = String(req.headers['accept-encoding'] ?? '');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const runtime = await startLocalProxyRuntime({
      // No injected items — these tests exercise forwarding/streaming behavior,
      // not injection (which now requires TLS, see proxy-tls.test.ts).
      managedItems: [],
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
      egressMode: 'permissive',
    });

    await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/`, {
      'accept-encoding': 'gzip, br, deflate',
    });

    // The proxy no longer forces identity (avoids the bandwidth/compat cost for
    // a low-value protection); the client's encoding preference is preserved.
    expect(receivedAcceptEncoding).toBe('gzip, br, deflate');

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('emits a blocked-egress activity in strict mode (no secrets in the activity)', async () => {
    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [],
      egressMode: 'strict',
      onActivity: (a) => activities.push(a),
    });

    await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://example.com/some/path');

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      decision: 'blocked-egress', host: 'example.com', method: 'GET', path: '/some/path', matched: false, blocked: true,
    });
    expect(activities[0]!.injectedKeys).toBeUndefined();

    await runtime.stop();
  });

  test('emits a deny activity (block rule) that never reaches upstream', async () => {
    let upstreamHit = false;
    const upstream = http.createServer((_req, res) => {
      upstreamHit = true;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [
        {
          domain: ['127.0.0.1'], itemKeys: [], block: true,
        },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });

    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/charge`);
    expect(response.statusCode).toBe(403);
    expect(upstreamHit).toBe(false);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      decision: 'deny', host: '127.0.0.1', path: '/charge', matched: true, blocked: true,
    });
    expect(activities[0]!.ruleId).toContain('block');

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('emits a single blocked-cleartext activity (not allow-then-block) and no secret', async () => {
    const upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'PH_placeholder', realValue: 'sk-REAL-secret' }],
      rules: [{ domain: ['127.0.0.1'], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });

    await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/`, {
      authorization: 'Bearer PH_placeholder',
    });

    expect(activities).toHaveLength(1);
    expect(activities[0]!.decision).toBe('blocked-cleartext');
    expect(JSON.stringify(activities)).not.toContain('sk-REAL-secret');

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('emits an allow activity for a forwarded (non-injected) request', async () => {
    const upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });

    await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/list?page=2`);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      decision: 'allow', host: '127.0.0.1', path: '/list', matched: true, blocked: false,
    });
    // path excludes the query; the full url is carried separately for the hash
    expect(activities[0]!.path).toBe('/list');
    expect(activities[0]!.url).toBe('/list?page=2');
    expect(activities[0]!.injectedKeys).toBeUndefined();

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('require-approval: a denied request never reaches upstream (fail closed)', async () => {
    let upstreamHit = false;
    const upstream = http.createServer((_req, res) => {
      upstreamHit = true;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [
        {
          domain: ['127.0.0.1'], itemKeys: [], approval: {},
        },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
      approvalProvider: { async requestApproval(r) { return { approved: false, nonce: r.nonce }; } },
    });

    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/v1/refunds`);
    expect(response.statusCode).toBe(403);
    expect(upstreamHit).toBe(false);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ decision: 'approval-denied', blocked: true, path: '/v1/refunds' });

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('require-approval: an approved request is forwarded and audited as approval-granted', async () => {
    let upstreamHit = false;
    const upstream = http.createServer((_req, res) => {
      upstreamHit = true;
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const seen: Array<{ method: string; path: string; bodyHash: string }> = [];
    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [
        {
          domain: ['127.0.0.1'], itemKeys: [], approval: {},
        },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
      approvalProvider: {
        async requestApproval(r) {
          // the provider is handed the request-bound details (Invariant #8)
          seen.push({ method: r.method, path: r.path, bodyHash: r.bodyHash });
          return { approved: true, nonce: r.nonce };
        },
      },
    });

    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/v1/refunds`);
    expect(response.statusCode).toBe(200);
    expect(upstreamHit).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/v1/refunds' });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.decision).toBe('approval-granted');

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('approval downgrade closed: an approval-gated key is not injected on a plain-allow-exempted path', async () => {
    let upstreamHit = false;
    let approvalCalls = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamHit = true;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'SECRET', placeholder: 'PH_SECRET', realValue: 'REAL_SECRET_VALUE' }],
      rules: [
        // Broad rule carrying SECRET, gated behind approval.
        { domain: ['127.0.0.1'], itemKeys: ['SECRET'], approval: {} },
        // More-specific plain-allow rule exempting /health — this decides the
        // verdict (specificity), so the approval gate is skipped on /health.
        { domain: ['127.0.0.1'], path: '/health', itemKeys: [] },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
      // Would approve if ever asked — proving the point that it is NOT asked, and
      // the secret is still withheld rather than smuggled in without a prompt.
      approvalProvider: {
        async requestApproval(r) {
          approvalCalls += 1;
          return { approved: true, nonce: r.nonce };
        },
      },
    });

    const response = await requestViaProxy(
      runtime.env.HTTP_PROXY!,
      `http://127.0.0.1:${addr.port}/health`,
      { authorization: 'Bearer PH_SECRET' },
    );

    // The real value never reaches (or is echoed by) the upstream, the approval
    // gate was correctly skipped (verdict = allow), and — the regression this
    // guards — SECRET was WITHHELD from injection scope, so the request is blocked
    // as uninjected rather than being injected without a prompt. Before the fix,
    // SECRET leaked into scope and the cleartext guard fired instead
    // (decision 'blocked-cleartext').
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('REAL_SECRET_VALUE');
    expect(upstreamHit).toBe(false);
    expect(approvalCalls).toBe(0);
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-uninjected', blocked: true, path: '/health' });

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('streams text/event-stream responses through incrementally (no buffering)', async () => {
    const INTER_CHUNK_DELAY = 200;
    const upstream = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, INTER_CHUNK_DELAY);
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const runtime = await startLocalProxyRuntime({
      // No injected items — these tests exercise forwarding/streaming behavior,
      // not injection (which now requires TLS, see proxy-tls.test.ts).
      managedItems: [],
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
      egressMode: 'permissive',
    });

    const proxy = new URL(runtime.env.HTTP_PROXY!);
    const { gapMs, body } = await new Promise<{ gapMs: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: `http://127.0.0.1:${addr.port}/`,
      }, (res) => {
        let firstAt = 0;
        let lastAt = 0;
        const chunks: Array<Buffer> = [];
        res.on('data', (chunk: Buffer) => {
          const now = Date.now();
          firstAt ||= now;
          lastAt = now;
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ gapMs: lastAt - firstAt, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });

    expect(body).toContain('data: one');
    expect(body).toContain('data: two');
    // If the proxy had buffered the whole response, both chunks would arrive
    // together at the end and the gap would be ~0. A gap near the server's
    // inter-chunk delay proves chunks were forwarded as they arrived.
    expect(gapMs).toBeGreaterThanOrEqual(INTER_CHUNK_DELAY - 80);

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });
});

describe('varlock.internal session-env endpoint', () => {
  const TOKEN = 'test-session-token-uuid';
  const PAYLOAD_JSON = JSON.stringify({
    env: { FOO: 'bar', API_KEY: 'vlk_placeholder_API_KEY_abc' },
    omittedKeys: ['ADMIN_TOKEN'],
    serializedGraph: { settings: {}, config: {}, sources: [] },
  });

  async function startWithEndpoint(opts?: { egressMode?: 'permissive' | 'strict'; skipPayload?: boolean }) {
    const activities: Array<ProxyActivity> = [];
    const authFailures: Array<true> = [];
    const served: Array<{ passthroughCount?: number } | undefined> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [],
      egressMode: opts?.egressMode ?? 'permissive',
      internalEndpoint: {
        token: TOKEN,
        onAuthFailure: () => authFailures.push(true),
        onServed: (meta) => served.push(meta),
      },
      onActivity: (a) => activities.push(a),
    });
    if (!opts?.skipPayload) runtime.setSessionEnvPayloadJson(PAYLOAD_JSON, { passthroughCount: 2 });
    return {
      runtime, activities, authFailures, served,
    };
  }

  test('serves the current payload with a valid token, without reporting egress activity', async () => {
    const {
      runtime, activities, served, authFailures,
    } = await startWithEndpoint();
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual(JSON.parse(PAYLOAD_JSON));
    // control plane, not traffic: never counted as egress
    expect(activities).toEqual([]);
    // owner visibility: served callback fires with the payload's meta, no auth failures
    expect(served).toEqual([{ passthroughCount: 2 }]);
    expect(authFailures).toEqual([]);
    await runtime.stop();
  });

  test('serves the LATEST payload after a swap (reload freshness)', async () => {
    const { runtime } = await startWithEndpoint();
    const updated = JSON.stringify({ env: { FOO: 'post-reload' }, omittedKeys: [], serializedGraph: { config: {} } });
    runtime.setSessionEnvPayloadJson(updated);
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(JSON.parse(res.body).env.FOO).toBe('post-reload');
    await runtime.stop();
  });

  test('refuses a missing or wrong token with 403, serves nothing, and surfaces the attempt', async () => {
    const { runtime, authFailures, served } = await startWithEndpoint();
    const noToken = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
    });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.body).not.toContain('API_KEY');
    const wrongToken = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': 'wrong-token-same-length--',
    });
    expect(wrongToken.statusCode).toBe(403);
    // both attempts surfaced to the owner; nothing served
    expect(authFailures).toEqual([true, true]);
    expect(served).toEqual([]);
    await runtime.stop();
  });

  test('403s when the endpoint is not enabled, even with some token', async () => {
    const runtime = await startLocalProxyRuntime({ managedItems: [], rules: [], egressMode: 'permissive' });
    runtime.setSessionEnvPayloadJson(PAYLOAD_JSON);
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(403);
    await runtime.stop();
  });

  test('404s an unknown internal path (token first: only authenticated callers learn paths)', async () => {
    const { runtime } = await startWithEndpoint();
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/nope', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(404);
    await runtime.stop();
  });

  test('503s when the payload has not been set yet', async () => {
    const { runtime } = await startWithEndpoint({ skipPayload: true });
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(503);
    await runtime.stop();
  });

  test('reachable under strict egress (handled before the egress gate)', async () => {
    const { runtime } = await startWithEndpoint({ egressMode: 'strict' });
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(200);
    await runtime.stop();
  });
});

describe('startLocalProxyRuntime — fixed port and cert dir', () => {
  test('binds a caller-provided port (surfaced as HTTP(S)_PROXY)', async () => {
    const port = await getFreePort();
    const runtime = await startLocalProxyRuntime({
      managedItems: [], rules: [], egressMode: 'permissive', port,
    });
    expect(runtime.env.HTTP_PROXY).toBe(`http://127.0.0.1:${port}`);
    expect(runtime.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${port}`);
    await runtime.stop();
  });

  test('a busy fixed port fails to start with a clear error', async () => {
    const port = await getFreePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(port, '127.0.0.1', () => resolve());
    });
    try {
      await expect(startLocalProxyRuntime({
        managedItems: [], rules: [], egressMode: 'permissive', port,
      })).rejects.toThrow(new RegExp(`port ${port} is already in use`));
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }
  });

  test('writes the CA cert into a caller-provided dir; stop removes only its files, not the dir', async () => {
    const certDir = mkdtempSync(path.join(os.tmpdir(), 'vlk-certdir-'));
    try {
      const runtime = await startLocalProxyRuntime({
        managedItems: [], rules: [], egressMode: 'permissive', certDir,
      });
      const caCert = path.join(certDir, 'ca-cert.pem');
      const combined = path.join(certDir, 'combined-ca.pem');
      expect(existsSync(caCert)).toBe(true);
      expect(existsSync(combined)).toBe(true);
      expect(runtime.env.NODE_EXTRA_CA_CERTS).toBe(caCert); // known CA path a caller can wire up

      await runtime.stop();
      expect(existsSync(caCert)).toBe(false); // cert files we wrote are cleaned
      expect(existsSync(combined)).toBe(false);
      expect(existsSync(certDir)).toBe(true); // but the caller's dir is left alone
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});
