import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import https from 'node:https';

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
