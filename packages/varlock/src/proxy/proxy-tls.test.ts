import {
  describe, expect, test, vi,
} from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import outdent from 'outdent';

import { DotEnvFileDataSource, EnvGraph } from '../env-graph/index';

import { startLocalProxyRuntime } from './runtime-proxy';
import { createHostCert } from './cert-authority';
import {
  openMitmTunnel, sendAndRead, setupMitmHarness, UPSTREAM_HOST,
} from './mitm-test-harness';

// End-to-end exercise of the HTTPS MITM transport: a real TLS client, trusting
// only the proxy's CA, opens a CONNECT tunnel and handshakes against the proxy's
// minted leaf, and the proxy forwards to a stub HTTPS upstream. Covers the
// cert-trust + CONNECT + streaming + response-scrubbing mechanics that the
// plain-HTTP unit tests can't reach. Which parts of a request get substituted is
// covered in proxy-substitution.test.ts.

const harness = setupMitmHarness();
const { startUpstream } = harness;

describe('proxy HTTPS MITM (end-to-end)', () => {
  test('client trusts the minted leaf and the real key is injected upstream', async () => {
    let upstreamAuthHeader = '';
    const upstream = await startUpstream((req, res) => {
      upstreamAuthHeader = String(req.headers.authorization ?? '');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const body = await new Promise<string>((resolve, reject) => {
      let buf = '';
      let idleTimer: ReturnType<typeof setTimeout>;
      tlsSocket.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        // The MITM connection may stay keep-alive, so resolve once the response
        // has settled rather than waiting for the socket to close.
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => resolve(buf), 250);
      });
      tlsSocket.on('end', () => resolve(buf));
      tlsSocket.on('error', reject);
      tlsSocket.write(
        `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
          + 'Authorization: Bearer sk-stub-PLACEHOLDER\r\n\r\n',
      );
    });

    // Client completed the TLS handshake against our leaf (openMitmTunnel would
    // have thrown otherwise) and got a 200 back.
    expect(body.split('\r\n')[0]).toContain('200');
    // The proxy swapped the placeholder for the real key before the upstream saw it.
    expect(upstreamAuthHeader).toBe('Bearer sk-stub-REALKEY');
    expect(upstreamAuthHeader).not.toContain('PLACEHOLDER');

    // The audit activity records the injected item by KEY, with the real
    // decision, and never carries the real (or placeholder) secret value.
    const allow = activities.find((a) => a.decision === 'allow');
    expect(allow).toBeDefined();
    expect(allow).toMatchObject({ host: UPSTREAM_HOST, method: 'GET', injectedKeys: ['API_KEY'] });
    expect(JSON.stringify(activities)).not.toContain('sk-stub-REALKEY');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('SSE responses stream through the MITM path incrementally', async () => {
    const INTER_CHUNK_DELAY = 200;
    const upstream = await startUpstream((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, INTER_CHUNK_DELAY);
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const marks = await new Promise<Record<string, number>>((resolve, reject) => {
      const times: Record<string, number> = {};
      let buf = '';
      tlsSocket.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        for (const marker of ['data: one', 'data: two']) {
          if (!(marker in times) && buf.includes(marker)) times[marker] = Date.now();
        }
        // Resolve as soon as both events have arrived (connection may stay open).
        if ('data: one' in times && 'data: two' in times) resolve(times);
      });
      tlsSocket.on('end', () => resolve(times));
      tlsSocket.on('error', reject);
      tlsSocket.write(`GET /stream HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\nAuthorization: Bearer sk-stub-PLACEHOLDER\r\n\r\n`);
    });

    expect(marks['data: one']).toBeDefined();
    expect(marks['data: two']).toBeDefined();
    // First event arrived well before the second — proof the MITM path forwarded
    // chunks as they came rather than buffering the whole stream.
    expect(marks['data: two']! - marks['data: one']!).toBeGreaterThanOrEqual(INTER_CHUNK_DELAY - 80);

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('does NOT inject when the upstream cert is for a different host (Invariant #1 / DNS-poison)', async () => {
    // The upstream listens on 127.0.0.1 but presents a cert for a DIFFERENT
    // name — exactly what a DNS-poisoned / rebound host does, since it cannot
    // obtain a valid cert for the host the rule targets.
    const wrongLeaf = await createHostCert(harness.upstreamCa(), 'wrong.example');
    let upstreamGotRequest = false;
    let upstreamAuth = '';
    const server = https.createServer({ key: wrongLeaf.keyPem, cert: wrongLeaf.certPem }, (req, res) => {
      upstreamGotRequest = true;
      upstreamAuth = String(req.headers.authorization ?? '');
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((res) => {
      server.listen(0, UPSTREAM_HOST, () => res());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no upstream addr');

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, addr.port);
    // The connection fails closed (reset/closed), so don't depend on reading a
    // response — assert the security property on the upstream side instead.
    tlsSocket.on('error', () => { /* expected: connection torn down */ });
    tlsSocket.write(
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${addr.port}\r\nConnection: close\r\nAuthorization: Bearer sk-stub-PLACEHOLDER\r\n\r\n`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    // Upstream identity didn't match the dialed host → the request (and its
    // injected secret) was never transmitted upstream. This is the DNS-poison
    // defense: a host that can't prove its identity gets no secret.
    expect(upstreamGotRequest).toBe(false);
    expect(upstreamAuth).not.toContain('sk-stub-REALKEY');

    tlsSocket.destroy();
    await runtime.stop();
    await new Promise<void>((res) => {
      server.close(() => res());
    });
  });

  test('redacts real values out of responses back to placeholders', async () => {
    const REAL = 'sk-stub-REALKEY';
    const upstream = await startUpstream((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-echo-secret', `token=${REAL}`);
      res.end(JSON.stringify({ apiKey: REAL }));
    });

    const responses: Array<{ statusCode: number; scrubbedKeys: Array<string> }> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: REAL }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
      onResponse: (info) => responses.push({ statusCode: info.statusCode, scrubbedKeys: info.scrubbedKeys }),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\nAuthorization: Bearer sk-stub-PLACEHOLDER\r\n\r\n`,
    );

    // The real value the upstream echoed (body + header) is scrubbed back to the
    // placeholder before it reaches the client.
    expect(response).toContain('sk-stub-PLACEHOLDER');
    expect(response).not.toContain(REAL);

    // ...and onResponse reports which key was scrubbed (for the live proxy-start log).
    expect(responses).toEqual([{ statusCode: 200, scrubbedKeys: ['API_KEY'] }]);

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('scrubs real values out of a streamed (SSE) response (Invariant #6)', async () => {
    const REAL = 'sk-stub-REALKEY';
    const upstream = await startUpstream((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.write(`data: {"echoed":"${REAL}"}\n\n`);
      setTimeout(() => {
        res.write('data: done\n\n');
        res.end();
      }, 100);
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: REAL }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET /stream HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\nAuthorization: Bearer sk-stub-PLACEHOLDER\r\n\r\n`,
    );

    // A secret reflected in the SSE stream is scrubbed chunk-by-chunk — the child
    // never sees the real value, even though the response wasn't buffered.
    expect(response).toContain('sk-stub-PLACEHOLDER');
    expect(response).not.toContain(REAL);

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('denies a request matched by a block rule, never reaching upstream (static authz)', async () => {
    let upstreamGotRequest = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamGotRequest = true;
      res.statusCode = 200;
      res.end('ok');
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [
        { domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] },
        {
          domain: [UPSTREAM_HOST], path: '/v1/charges', method: ['POST'], itemKeys: [], block: true,
        },
      ],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // Denied request fails closed (best-effort 403, then connection torn down),
    // so assert the security guarantee on the upstream side.
    tlsSocket.on('error', () => { /* expected: connection torn down */ });
    tlsSocket.write(
      `POST /v1/charges HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    // The blocked endpoint never reached the upstream — static per-call authorization.
    expect(upstreamGotRequest).toBe(false);

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('only injects an item on hosts its own rule matches (per-item domain scoping)', async () => {
    let receivedXTest = '';
    const upstream = await startUpstream((req, res) => {
      receivedXTest = String(req.headers['x-test'] ?? '');
      res.statusCode = 200;
      res.end('ok');
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [
        { key: 'ITEM_A', placeholder: 'PH_A_xxxxx', realValue: 'REAL_A_secret' },
        { key: 'ITEM_B', placeholder: 'PH_B_xxxxx', realValue: 'REAL_B_secret' },
      ],
      rules: [
        { domain: [UPSTREAM_HOST], itemKeys: ['ITEM_A'] },
        { domain: ['other-host.example'], itemKeys: ['ITEM_B'] },
      ],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    await sendAndRead(
      tlsSocket,
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\nx-test: a=PH_A_xxxxx;b=PH_B_xxxxx\r\n\r\n`,
    );

    // ITEM_A's rule matches this host → injected. ITEM_B's rule is for a
    // different host → its placeholder passes through untouched (no leak).
    expect(receivedXTest).toContain('REAL_A_secret');
    expect(receivedXTest).toContain('PH_B_xxxxx');
    expect(receivedXTest).not.toContain('REAL_B_secret');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });
});

describe('request signing (transform=) over MITM', () => {
  const SIGNING_TRANSFORM = {
    scheme: 'hmac-sha256',
    secretKey: { itemRef: 'SIGNING_SECRET' },
    stringToSign: '{timestamp}{method}{pathWithQuery}{body}',
    signatureHeader: 'x-signature',
    timestampHeader: 'x-timestamp',
    keyId: { itemRef: 'KEY_ID' },
    keyHeader: 'x-api-key',
    encoding: 'hex',
  } as const;
  const SIGNING_ITEMS = [
    { key: 'SIGNING_SECRET', placeholder: 'vlk_ph_signing_secret', realValue: 'shhh-signing-secret' },
    { key: 'KEY_ID', placeholder: 'vlk_ph_key_id', realValue: 'kid-real-value' },
  ];

  test('signs the outbound request with the real secret; child-sent garbage is overwritten; secret never travels', async () => {
    let upstreamHeaders: import('node:http').IncomingHttpHeaders = {};
    let upstreamBody = '';
    const upstream = await startUpstream((req, res) => {
      upstreamHeaders = req.headers;
      req.on('data', (c: Buffer) => {
        upstreamBody += c.toString('utf8');
      });
      req.on('end', () => {
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: SIGNING_ITEMS,
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['KEY_ID'], transform: SIGNING_TRANSFORM }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // The child signs nothing useful (an SDK given placeholder creds produces
    // garbage) - the proxy must overwrite, not duplicate, these headers.
    const payload = '{"size":1}';
    const response = await sendAndRead(
      tlsSocket,
      `POST /orders?limit=5 HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `X-Signature: bogus-child-signature\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );
    expect(response.split('\r\n')[0]).toContain('200');

    // Signature verifies against the exact bytes the upstream received, under
    // the REAL secret the child never held.
    const timestamp = String(upstreamHeaders['x-timestamp']);
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
    const expectedSig = createHmac('sha256', 'shhh-signing-secret')
      .update(`${timestamp}POST/orders?limit=5${upstreamBody}`, 'utf8')
      .digest('hex');
    expect(upstreamHeaders['x-signature']).toBe(expectedSig);
    expect(upstreamHeaders['x-api-key']).toBe('kid-real-value');
    expect(upstreamBody).toBe(payload);

    // The signing secret appears nowhere in the upstream request, and the audit
    // records the scheme but never a secret value.
    const upstreamRequestText = JSON.stringify(upstreamHeaders) + upstreamBody;
    expect(upstreamRequestText).not.toContain('shhh-signing-secret');
    expect(upstreamRequestText).not.toContain('vlk_ph_signing_secret');
    expect(activities.find((a) => a.decision === 'allow')).toMatchObject({ transformedWith: 'hmac-sha256' });
    expect(JSON.stringify(activities)).not.toContain('shhh-signing-secret');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('blocks a request carrying the signing secret placeholder (it is consumed, never sent)', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.end('{}');
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: SIGNING_ITEMS,
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['KEY_ID'], transform: SIGNING_TRANSFORM }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    const payload = JSON.stringify({ exfil: 'vlk_ph_signing_secret' });
    tlsSocket.write(
      `POST /orders HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    expect(upstreamHit).toBe(false);
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-transform', blocked: true });
    expect(JSON.stringify(activities)).not.toContain('shhh-signing-secret');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('two different transform configs matching one request fail closed as a misconfiguration', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.end('{}');
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: SIGNING_ITEMS,
      rules: [
        { domain: [UPSTREAM_HOST], itemKeys: [], transform: SIGNING_TRANSFORM },
        { domain: [UPSTREAM_HOST], itemKeys: [], transform: { ...SIGNING_TRANSFORM, signatureHeader: 'x-other-sig' } },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    tlsSocket.write(`GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`);
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    expect(upstreamHit).toBe(false);
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-transform', blocked: true });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('a transform whose signing credential has no resolved value fails closed', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.end('{}');
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [], // SIGNING_SECRET never resolved
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: [], transform: SIGNING_TRANSFORM }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    tlsSocket.write(`GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`);
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    // Identity verification succeeded (upstream is live) but the transform had no
    // secret to sign with - the request must never reach the upstream.
    expect(upstreamHit).toBe(false);
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-transform', blocked: true });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });
});

describe('plugin-provided transform schemes over MITM (scheme registry seam)', () => {
  // A fake scheme exercising the full seam: spec-driven credential resolution,
  // setHeaders/removeHeaders application, and status pass-through - without any
  // real crypto, so these tests cover the runtime, not a scheme.
  const TEST_SCHEME_DEF = {
    options: {
      tokenId: { required: true, type: 'string', itemRole: 'wire' },
      signatureHeader: { required: true, type: 'headerName' },
    },
    apply: (transform: any, input: any) => ({
      ok: true as const,
      setHeaders: {
        [transform.signatureHeader]: `test-signed:${input.credentials.secretKey}:${input.credentials.tokenId}:${input.body.length}`,
      },
      removeHeaders: ['x-test-strip'],
    }),
  };
  const TEST_ITEMS = [
    { key: 'SIGNING_SECRET', placeholder: 'vlk_ph_signing_secret', realValue: 'shhh-signing-secret' },
    { key: 'TOKEN_ID', placeholder: 'vlk_ph_token_id', realValue: 'tok-real-value' },
  ];
  const TEST_TRANSFORM = {
    scheme: 'test-sign', secretKey: { itemRef: 'SIGNING_SECRET' }, tokenId: { itemRef: 'TOKEN_ID' }, signatureHeader: 'x-test-sig',
  };

  test('resolves credentials per the option specs, applies set/remove headers, audits ONE allow entry', async () => {
    let upstreamHeaders: import('node:http').IncomingHttpHeaders = {};
    let upstreamBody = '';
    const upstream = await startUpstream((req, res) => {
      upstreamHeaders = req.headers;
      req.on('data', (c: Buffer) => {
        upstreamBody += c.toString('utf8');
      });
      req.on('end', () => {
        res.statusCode = 200;
        res.end('{}');
      });
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: TEST_ITEMS,
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['TOKEN_ID'], transform: TEST_TRANSFORM }],
      transformSchemes: { 'test-sign': TEST_SCHEME_DEF as any },
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const payload = '{"a":1}';
    const response = await sendAndRead(
      tlsSocket,
      `POST /x HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + 'X-Test-Strip: remove-me\r\nX-Token: vlk_ph_token_id\r\n'
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );
    expect(response.split('\r\n')[0]).toContain('200');

    // The transform saw the resolved REAL credential values (per item roles) and
    // its header edits were applied: signature set, x-test-strip removed.
    expect(upstreamHeaders['x-test-sig']).toBe(`test-signed:shhh-signing-secret:tok-real-value:${payload.length}`);
    expect(upstreamHeaders['x-test-strip']).toBeUndefined();
    // The wire-role item substituted normally alongside signing.
    expect(upstreamHeaders['x-token']).toBe('tok-real-value');
    expect(upstreamBody).toBe(payload);

    // Exactly ONE audit entry for the request, recorded AFTER the transform succeeded.
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ decision: 'allow', blocked: false, transformedWith: 'test-sign' });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('a transform whose scheme is not registered fails closed (plugin not loaded)', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.end('{}');
    });
    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: TEST_ITEMS,
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: [], transform: TEST_TRANSFORM }],
      // note: no transformSchemes passed - only built-in hmac schemes registered
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    tlsSocket.write(`GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`);
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    expect(upstreamHit).toBe(false);
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-transform', blocked: true });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('an approval-gated transform bypassed by a more specific allow rule fails closed, not unsigned', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.end('{}');
    });
    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: TEST_ITEMS,
      rules: [
        // broad rule carries approval + the transform...
        {
          domain: [UPSTREAM_HOST], itemKeys: [], transform: TEST_TRANSFORM, approval: {},
        },
        // ...but a more specific plain-allow rule wins the verdict (no prompt)
        { domain: [UPSTREAM_HOST], path: '/orders/**', itemKeys: [] },
      ],
      transformSchemes: { 'test-sign': TEST_SCHEME_DEF as any },
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    tlsSocket.write(`GET /orders/1 HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`);
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    // The request must NOT be forwarded unsigned - fail closed with a config-shaped error.
    expect(upstreamHit).toBe(false);
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-transform', blocked: true });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('equivalent transforms from two rules are not a conflict (key/list order insensitive)', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.end('{}');
    });
    const runtime = await startLocalProxyRuntime({
      managedItems: TEST_ITEMS,
      rules: [
        { domain: [UPSTREAM_HOST], itemKeys: [], transform: { ...TEST_TRANSFORM, allowedThings: ['a', 'b'] } },
        // same config: different key insertion order + different list order
        {
          domain: [UPSTREAM_HOST],
          itemKeys: [],
          transform: {
            signatureHeader: 'x-test-sig', allowedThings: ['b', 'a'], tokenId: { itemRef: 'TOKEN_ID' }, scheme: 'test-sign', secretKey: { itemRef: 'SIGNING_SECRET' },
          },
        },
      ],
      transformSchemes: { 'test-sign': TEST_SCHEME_DEF as any },
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`,
    );

    expect(response.split('\r\n')[0]).toContain('200');
    expect(upstreamHit).toBe(true);

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('dual-use: an item consumed by a transform stays substitutable where another rule injects it', async () => {
    let upstreamAuth = '';
    const upstream = await startUpstream((req, res) => {
      upstreamAuth = String(req.headers.authorization ?? '');
      res.end('{}');
    });
    const runtime = await startLocalProxyRuntime({
      managedItems: TEST_ITEMS,
      rules: [
        // the same item is a signing secret for one rule...
        { domain: [UPSTREAM_HOST], itemKeys: ['TOKEN_ID'], transform: TEST_TRANSFORM },
        // ...and a plainly-substituted credential via another rule
        { domain: [UPSTREAM_HOST], itemKeys: ['SIGNING_SECRET'] },
      ],
      transformSchemes: { 'test-sign': TEST_SCHEME_DEF as any },
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + 'Authorization: Bearer vlk_ph_signing_secret\r\n\r\n',
    );

    // NOT blocked as a signing-secret leak: rule 2 legitimately injects it here.
    expect(response.split('\r\n')[0]).toContain('200');
    expect(upstreamAuth).toBe('Bearer shhh-signing-secret');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('http-basic (built-in): proxy writes Basic base64(user:realsecret) over the child garbage header', async () => {
    let upstreamAuth = '';
    const upstream = await startUpstream((req, res) => {
      upstreamAuth = String(req.headers.authorization ?? '');
      res.end('{}');
    });
    const runtime = await startLocalProxyRuntime({
      managedItems: [
        { key: 'API_PASSWORD', placeholder: 'vlk_ph_api_password', realValue: 'real-password' },
        { key: 'API_USER', placeholder: 'vlk_ph_api_user', realValue: 'svc-user' },
      ],
      // note: no transformSchemes override - exercises the built-in default registry
      rules: [
        {
          domain: [UPSTREAM_HOST],
          itemKeys: [],
          transform: { scheme: 'http-basic', username: { itemRef: 'API_USER' }, password: { itemRef: 'API_PASSWORD' } },
        },
      ],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // the child's own Basic header encodes the placeholder - base64 hides it
    // from substitution entirely, which is exactly why this scheme exists
    const childBasic = Buffer.from('svc-user:vlk_ph_api_password').toString('base64');
    const response = await sendAndRead(
      tlsSocket,
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Authorization: Basic ${childBasic}\r\n\r\n`,
    );

    expect(response.split('\r\n')[0]).toContain('200');
    expect(upstreamAuth).toBe(`Basic ${Buffer.from('svc-user:real-password').toString('base64')}`);
    expect(upstreamAuth).not.toContain(childBasic);

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('response scrubbing covers this rule\'s sensitive values by role-independence, and spares the rest', async () => {
    // an endpoint that echoes back a mix: the encoded credential, the raw
    // secret, a secret bound for another route, and an ordinary username
    const upstream = await startUpstream((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        echoedAuth: String(req.headers.authorization ?? ''),
        rawSecret: 'real-password',
        unrelatedSecret: 'other-route-secret',
        who: 'svc-user',
      }));
    });
    const runtime = await startLocalProxyRuntime({
      managedItems: [
        { key: 'API_PASSWORD', placeholder: 'vlk_ph_api_password', realValue: 'real-password' },
        // an ordinary, explicitly non-sensitive username
        {
          key: 'API_USER', placeholder: 'vlk_ph_api_user', realValue: 'svc-user', isSensitive: false,
        },
        // a secret this request never touches
        { key: 'OTHER_SECRET', placeholder: 'vlk_ph_other', realValue: 'other-route-secret' },
      ],
      rules: [
        {
          domain: [UPSTREAM_HOST],
          itemKeys: [],
          transform: { scheme: 'http-basic', username: { itemRef: 'API_USER' }, password: { itemRef: 'API_PASSWORD' } },
        },
      ],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`,
    );

    // the encoded credential (only the scheme can produce this form)
    expect(response).not.toContain(Buffer.from('svc-user:real-password').toString('base64'));
    // ...and the raw secret behind it, whichever role it was named in
    expect(response).not.toContain('real-password');
    // ...but an ordinary, non-sensitive value is left alone rather than corrupted
    expect(response).toContain('svc-user');
    // ...as is a secret belonging to a DIFFERENT route: this upstream was never
    // given it, so scanning for it here is all corruption risk and no protection
    expect(response).toContain('other-route-secret');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('a scheme registered by a REAL loaded plugin runs through the runtime', async () => {
    // The tests above hand the runtime a hand-built scheme def, so they cannot
    // catch the plugin-facing contract drifting away from what a plugin actually
    // registers. This one goes through the real loader: schema -> @plugin ->
    // registry -> runtime -> outbound request.
    let upstreamHeaders: import('node:http').IncomingHttpHeaders = {};
    const upstream = await startUpstream((req, res) => {
      upstreamHeaders = req.headers;
      res.statusCode = 200;
      res.end('{}');
    });

    // relative @plugin(...) paths resolve against cwd - pin it at the fixture's dir
    const fixtureDir = path.join(__dirname, '../env-graph/test');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fixtureDir);
    const graph = new EnvGraph();
    await graph.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @plugin(./plugins/test-transform-plugin)
        # ---
        # @proxy(domain="${UPSTREAM_HOST}", transform={
        #   scheme="test-sign", tokenId=$TOKEN_ID, signatureHeader="X-Test-Sig",
        # })
        SIGNING_SECRET=shhh-real

        # @sensitive
        TOKEN_ID=tok-real
      `,
    }));
    await graph.finishLoad();
    await graph.resolveEnvValues();
    cwdSpy.mockRestore();

    const runtime = await startLocalProxyRuntime({
      managedItems: await graph.getProxyManagedItems(),
      rules: await graph.getProxyRules(),
      transformSchemes: graph.proxyTransformSchemes,
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET /x HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`,
    );

    // 200, not the 502 an unregistered/uncallable transform would produce
    expect(response.split('\r\n')[0]).toContain('200');
    // the header the FIXTURE's own code writes, with real credentials resolved
    expect(String(upstreamHeaders['x-test-sig'])).toMatch(/^test-signed:shhh-real:tok-real:\d+$/);

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('a reflected placeholder is left alone, and a cross-route secret is not scanned for', async () => {
    // Placeholders are inert, so one echoed back (an agent quoting its own env)
    // passes through untouched rather than being rewritten or flagged. A secret
    // bound to a DIFFERENT domain is not scanned for either: this upstream was
    // never given it, so a match would be coincidence, and rewriting it would
    // corrupt ordinary content. (Only ruled hosts are MITM'd at all.)
    const upstream = await startUpstream((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        quoted: 'vlk_ph_echoed',
        leaked: 'other-route-secret-value',
      }));
    });
    const runtime = await startLocalProxyRuntime({
      managedItems: [
        { key: 'ECHOED', placeholder: 'vlk_ph_echoed', realValue: 'echoed-real-value' },
        { key: 'OTHER_SECRET', placeholder: 'vlk_ph_other', realValue: 'other-route-secret-value' },
      ],
      rules: [
        // this host has a rule (so it is MITM'd) but injects nothing here
        { domain: [UPSTREAM_HOST], itemKeys: [] },
        // ...while both secrets belong to a domain this request never talks to
        { domain: ['other.example.com'], itemKeys: ['ECHOED', 'OTHER_SECRET'] },
      ],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`,
    );

    // the echoed placeholder is inert and passes through as-is
    expect(response).toContain('vlk_ph_echoed');
    // ...and it did NOT get swapped for the real value on the way out
    expect(response).not.toContain('echoed-real-value');
    // the cross-route secret is left as-is rather than rewritten
    expect(response).toContain('other-route-secret-value');
    expect(response).not.toContain('vlk_ph_other');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('http-basic: a reflected Authorization header is scrubbed from the response', async () => {
    // an endpoint that echoes the request's Authorization back would otherwise
    // hand the child a base64 token it can decode into the real password
    const upstream = await startUpstream((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ echoed: String(req.headers.authorization ?? '') }));
    });
    const runtime = await startLocalProxyRuntime({
      managedItems: [
        { key: 'API_PASSWORD', placeholder: 'vlk_ph_api_password', realValue: 'real-password' },
        { key: 'API_USER', placeholder: 'vlk_ph_api_user', realValue: 'svc-user' },
      ],
      rules: [
        {
          domain: [UPSTREAM_HOST],
          itemKeys: [],
          transform: { scheme: 'http-basic', username: { itemRef: 'API_USER' }, password: { itemRef: 'API_PASSWORD' } },
        },
      ],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`,
    );

    const basicToken = Buffer.from('svc-user:real-password').toString('base64');
    expect(response).not.toContain(basicToken);
    expect(response).not.toContain('real-password');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('binary bodies with no placeholder pass through byte-exact (no utf8 mangling)', async () => {
    const chunks: Array<Buffer> = [];
    const upstream = await startUpstream((req, res) => {
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => res.end('{}'));
    });
    const runtime = await startLocalProxyRuntime({
      managedItems: TEST_ITEMS,
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['TOKEN_ID'], transform: TEST_TRANSFORM }],
      transformSchemes: { 'test-sign': TEST_SCHEME_DEF as any },
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // invalid utf8 sequences - a naive decode/encode round-trip would corrupt these
    const binaryBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01, 0xc3, 0x28]);
    const header = `PUT /object.bin HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
      + `Content-Type: application/octet-stream\r\nContent-Length: ${binaryBody.length}\r\n\r\n`;
    const response = await new Promise<string>((resolve, reject) => {
      let buf = '';
      let idle: ReturnType<typeof setTimeout>;
      tlsSocket.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        clearTimeout(idle);
        idle = setTimeout(() => resolve(buf), 250);
      });
      tlsSocket.on('error', reject);
      tlsSocket.write(header);
      tlsSocket.write(binaryBody);
    });

    expect(response.split('\r\n')[0]).toContain('200');
    expect(Buffer.concat(chunks).equals(binaryBody)).toBe(true);

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });
});
