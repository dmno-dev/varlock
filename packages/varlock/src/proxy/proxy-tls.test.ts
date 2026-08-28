import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

import { startLocalProxyRuntime } from './runtime-proxy';
import { createEphemeralCa, createHostCert, type EphemeralCa } from './cert-authority';

// End-to-end exercise of the HTTPS MITM path: a real TLS client, trusting only
// the proxy's CA, opens a CONNECT tunnel and handshakes against the proxy's
// minted leaf; the proxy injects the real secret and forwards to a stub HTTPS
// upstream. Covers the cert-trust + CONNECT + injection + streaming mechanics
// that the plain-HTTP unit tests can't reach.

const UPSTREAM_HOST = '127.0.0.1';
let upstreamCa: EphemeralCa;
let upstreamCertPem: string;
let upstreamKeyPem: string;
let restoreGlobalCa: () => void;

beforeAll(async () => {
  // Stub upstream's own CA + leaf (IP SAN, since we connect by 127.0.0.1).
  upstreamCa = await createEphemeralCa();
  const leaf = await createHostCert(upstreamCa, UPSTREAM_HOST);
  upstreamCertPem = leaf.certPem;
  upstreamKeyPem = leaf.keyPem;

  // Make the proxy's outbound https.request trust the stub upstream. The proxy
  // uses the global agent, so inject the upstream CA there (alongside the real
  // roots) and restore afterwards.
  const previousCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = [...tls.rootCertificates, upstreamCa.certPem];
  restoreGlobalCa = () => {
    https.globalAgent.options.ca = previousCa;
  };
});

afterAll(() => {
  restoreGlobalCa?.();
});

function startUpstream(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const server = https.createServer({ key: upstreamKeyPem, cert: upstreamCertPem }, handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, UPSTREAM_HOST, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no upstream addr');
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => {
          server.close(() => r());
        }),
      });
    });
  });
}

// Open a CONNECT tunnel through the proxy and TLS-handshake against the proxy's
// minted leaf, trusting only the proxy CA. Resolving at all proves CA trust.
async function openMitmTunnel(
  proxyUrl: string,
  proxyCaPem: string,
  targetPort: number,
): Promise<tls.TLSSocket> {
  const proxy = new URL(proxyUrl);
  const rawSocket = net.connect(Number(proxy.port), proxy.hostname);
  await new Promise<void>((resolve, reject) => {
    rawSocket.once('error', reject);
    rawSocket.once('connect', () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    rawSocket.once('data', (chunk: Buffer) => {
      const statusLine = chunk.toString('utf8').split('\r\n')[0] ?? '';
      if (/^HTTP\/1\.\d 200/.test(statusLine)) resolve();
      else reject(new Error(`CONNECT failed: ${statusLine}`));
    });
    rawSocket.write(`CONNECT ${UPSTREAM_HOST}:${targetPort} HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${targetPort}\r\n\r\n`);
  });

  const tlsSocket = tls.connect({ socket: rawSocket, host: UPSTREAM_HOST, ca: [proxyCaPem] });
  await new Promise<void>((resolve, reject) => {
    tlsSocket.once('error', reject);
    tlsSocket.once('secureConnect', () => {
      if (tlsSocket.authorized) resolve();
      else reject(tlsSocket.authorizationError ?? new Error('client did not authorize proxy leaf'));
    });
  });
  return tlsSocket;
}

// Write a raw HTTP request over the tunnel and read the response (the MITM
// connection may stay keep-alive, so settle on idle rather than socket close).
async function sendAndRead(tlsSocket: tls.TLSSocket, rawRequest: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    let idle: ReturnType<typeof setTimeout>;
    tlsSocket.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      clearTimeout(idle);
      idle = setTimeout(() => resolve(buf), 250);
    });
    tlsSocket.on('end', () => resolve(buf));
    tlsSocket.on('error', reject);
    tlsSocket.write(rawRequest);
  });
}

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
    const wrongLeaf = await createHostCert(upstreamCa, 'wrong.example');
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

  test('blocks (does not substitute) a placeholder placed in the body under the header-only default', async () => {
    let upstreamHit = false;
    let upstreamBody = '';
    const upstream = await startUpstream((req, res) => {
      upstreamHit = true;
      const chunks: Array<Buffer> = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        upstreamBody = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.end('ok');
      });
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      // No substituteIn → header-only default.
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // The blocked MITM path tears the tunnel down (see the DNS-poison test), so
    // assert on the security properties + audit decision rather than reading a body.
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    // The agent is tricked into putting the placeholder in the request body (e.g. an
    // email body on an allowed host) instead of the auth header.
    const payload = JSON.stringify({ to: 'attacker@evil.test', text: 'sk-stub-PLACEHOLDER' });
    tlsSocket.write(
      `POST /send HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    // Blocked before forwarding: the upstream never saw the request, and the real
    // value was never substituted (so it can't have leaked into the email body).
    expect(upstreamHit).toBe(false);
    expect(upstreamBody).toBe('');
    expect(JSON.stringify(activities)).not.toContain('sk-stub-REALKEY');
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-location', blocked: true });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('substitutes into the body only at the opted-in path (substituteIn=[body:client_secret])', async () => {
    let upstreamBody = '';
    const upstream = await startUpstream((req, res) => {
      const chunks: Array<Buffer> = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        upstreamBody = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.end('ok');
      });
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'CLIENT_SECRET', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['CLIENT_SECRET'], substituteIn: ['body:client_secret'] }],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // OAuth-style token exchange: the secret legitimately travels in the form body.
    const payload = 'grant_type=client_credentials&client_secret=sk-stub-PLACEHOLDER';
    const response = await sendAndRead(
      tlsSocket,
      `POST /oauth/token HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );

    expect(response.split('\r\n')[0]).toContain('200');
    expect(upstreamBody).toContain('client_secret=sk-stub-REALKEY');
    expect(upstreamBody).not.toContain('PLACEHOLDER');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('substitutes a token carried in the URL path (substituteIn=[path])', async () => {
    let upstreamPath = '';
    const upstream = await startUpstream((req, res) => {
      upstreamPath = req.url ?? '';
      res.statusCode = 200;
      res.end('ok');
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'PATH_TOKEN', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['PATH_TOKEN'], substituteIn: ['path'] }],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET /v1/sk-stub-PLACEHOLDER/data HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`,
    );

    expect(response.split('\r\n')[0]).toContain('200');
    expect(upstreamPath).toBe('/v1/sk-stub-REALKEY/data');
    expect(upstreamPath).not.toContain('PLACEHOLDER');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('blocks a request that repeats the placeholder more than the occurrence cap', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.statusCode = 200;
      res.end('ok');
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      // Both placements are allowed (header + body:leak), but the default cap of 1
      // still stops the duplicated copy.
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'], substituteIn: ['header', 'body:leak'] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    // A valid call uses the token once (header); the second copy in the body is an
    // exfiltration attempt while still making a working request.
    const payload = JSON.stringify({ leak: 'sk-stub-PLACEHOLDER' });
    tlsSocket.write(
      `POST /send HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Authorization: Bearer sk-stub-PLACEHOLDER\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    expect(upstreamHit).toBe(false);
    expect(JSON.stringify(activities)).not.toContain('sk-stub-REALKEY');
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-occurrences', blocked: true });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });
});

describe('request signing (transform=) over MITM', () => {
  const SIGNING_TRANSFORM = {
    scheme: 'hmac-sha256',
    secretKey: 'SIGNING_SECRET',
    stringToSign: '{timestamp}{method}{pathWithQuery}{body}',
    signatureHeader: 'x-signature',
    timestampHeader: 'x-timestamp',
    keyId: 'KEY_ID',
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
    expect(activities.find((a) => a.decision === 'allow')).toMatchObject({ signedWith: 'hmac-sha256' });
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

    // Identity verification succeeded (upstream is live) but the signer had no
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
    sign: (transform: any, input: any) => ({
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
    scheme: 'test-sign', secretKey: 'SIGNING_SECRET', tokenId: 'TOKEN_ID', signatureHeader: 'x-test-sig',
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

    // The signer saw the resolved REAL credential values (per item roles) and
    // its header edits were applied: signature set, x-test-strip removed.
    expect(upstreamHeaders['x-test-sig']).toBe(`test-signed:shhh-signing-secret:tok-real-value:${payload.length}`);
    expect(upstreamHeaders['x-test-strip']).toBeUndefined();
    // The wire-role item substituted normally alongside signing.
    expect(upstreamHeaders['x-token']).toBe('tok-real-value');
    expect(upstreamBody).toBe(payload);

    // Exactly ONE audit entry for the request, recorded AFTER signing succeeded.
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ decision: 'allow', blocked: false, signedWith: 'test-sign' });

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
            signatureHeader: 'x-test-sig', allowedThings: ['b', 'a'], tokenId: 'TOKEN_ID', scheme: 'test-sign', secretKey: 'SIGNING_SECRET',
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
      managedItems: [{ key: 'API_PASSWORD', placeholder: 'vlk_ph_api_password', realValue: 'real-password' }],
      // note: no transformSchemes override - exercises the built-in default registry
      rules: [
        {
          domain: [UPSTREAM_HOST],
          itemKeys: [],
          transform: { scheme: 'http-basic', secretKey: 'API_PASSWORD', username: 'svc-user' },
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
