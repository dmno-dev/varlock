import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import { createHash, createHmac } from 'node:crypto';
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

describe('AWS SigV4 re-signing (transform={scheme="aws-sigv4"}) over MITM', () => {
  const SIGV4_ITEMS = [
    { key: 'AWS_SECRET_ACCESS_KEY', placeholder: 'vlk_ph_aws_secret', realValue: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYREALKEY' },
    { key: 'AWS_ACCESS_KEY_ID', placeholder: 'VLKPLACEHOLDERAKID', realValue: 'AKIDREALKEY' },
  ];
  const SIGV4_TRANSFORM = {
    scheme: 'aws-sigv4', secretKey: 'AWS_SECRET_ACCESS_KEY', keyId: 'AWS_ACCESS_KEY_ID',
  } as const;

  /** An SDK-style inbound request signed with placeholder creds and a stale date. */
  const placeholderSignedHeaders = 'Authorization: AWS4-HMAC-SHA256 Credential=VLKPLACEHOLDERAKID/20260101/us-east-1/execute-api/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000\r\n'
    + 'X-Amz-Date: 20260101T000000Z\r\n';

  test('re-signs with real keys; signature verifies over the exact bytes the upstream received', async () => {
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
      managedItems: SIGV4_ITEMS,
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['AWS_ACCESS_KEY_ID'], transform: SIGV4_TRANSFORM }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const payload = '{"TableName":"widgets"}';
    const response = await sendAndRead(
      tlsSocket,
      `POST /prod/items?limit=2 HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n${
        placeholderSignedHeaders
      }Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );
    expect(response.split('\r\n')[0]).toContain('200');

    // Fresh signature under the REAL key id, over the body the upstream received.
    const authorization = String(upstreamHeaders.authorization);
    const amzDate = String(upstreamHeaders['x-amz-date']);
    expect(authorization).toContain(`Credential=AKIDREALKEY/${amzDate.slice(0, 8)}/us-east-1/execute-api/aws4_request`);
    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);
    expect(amzDate).not.toBe('20260101T000000Z');
    expect(upstreamHeaders['x-amz-content-sha256'])
      .toBe(createHash('sha256').update(upstreamBody).digest('hex'));
    expect(upstreamBody).toBe(payload);

    // End-to-end signature verification: replay exactly the headers the upstream
    // saw listed in SignedHeaders through the reference signer and expect the
    // identical Authorization header.
    const signedHeaderNames = authorization.match(/SignedHeaders=([^,]+),/)![1].split(';');
    const replayHeaders: Record<string, string> = {};
    for (const name of signedHeaderNames) replayHeaders[name] = String(upstreamHeaders[name]);
    const { SignatureV4 } = await import('@smithy/signature-v4');
    const { HttpRequest } = await import('@smithy/protocol-http');
    const { createHmac: nodeHmac, createHash: nodeHash } = await import('node:crypto');
    class TestSha256 {
      private h: ReturnType<typeof nodeHash> | ReturnType<typeof nodeHmac>;
      constructor(secret?: string | Uint8Array) {
        this.h = secret !== undefined ? nodeHmac('sha256', secret) : nodeHash('sha256');
      }

      update(d: string | Uint8Array) {
        this.h.update(d);
      }

      digest() {
        return Promise.resolve(this.h.digest());
      }
    }
    const replaySigner = new SignatureV4({
      credentials: { accessKeyId: 'AKIDREALKEY', secretAccessKey: SIGV4_ITEMS[0].realValue },
      region: 'us-east-1',
      service: 'execute-api',
      sha256: TestSha256 as any,
      applyChecksum: false,
    });
    const signingDate = new Date(Date.UTC(
      Number(amzDate.slice(0, 4)),
      Number(amzDate.slice(4, 6)) - 1,
      Number(amzDate.slice(6, 8)),
      Number(amzDate.slice(9, 11)),
      Number(amzDate.slice(11, 13)),
      Number(amzDate.slice(13, 15)),
    ));
    const replayed = await replaySigner.sign(new HttpRequest({
      protocol: 'https:',
      hostname: UPSTREAM_HOST,
      method: 'POST',
      path: '/prod/items',
      query: { limit: '2' },
      headers: replayHeaders,
    }), { signingDate, signableHeaders: new Set(signedHeaderNames) });
    expect(replayed.headers.authorization ?? replayed.headers.Authorization).toBe(authorization);

    // The real secret key never appears anywhere the upstream (or audit) can see.
    const upstreamRequestText = JSON.stringify(upstreamHeaders) + upstreamBody;
    expect(upstreamRequestText).not.toContain(SIGV4_ITEMS[0].realValue);
    expect(upstreamRequestText).not.toContain('vlk_ph_aws_secret');
    expect(activities.find((a) => a.decision === 'allow')).toMatchObject({ signedWith: 'aws-sigv4' });
    expect(JSON.stringify(activities)).not.toContain(SIGV4_ITEMS[0].realValue);

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('blocks a request the child did not placeholder-sign (nothing to derive scope from)', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.end('{}');
    });
    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: SIGV4_ITEMS,
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['AWS_ACCESS_KEY_ID'], transform: SIGV4_TRANSFORM }],
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

  test('blocks a scope outside allowedRegions', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.end('{}');
    });
    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: SIGV4_ITEMS,
      rules: [
        {
          domain: [UPSTREAM_HOST],
          itemKeys: ['AWS_ACCESS_KEY_ID'],
          transform: { ...SIGV4_TRANSFORM, allowedRegions: ['eu-west-1'] },
        },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    tlsSocket.write(
      `GET / HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n${placeholderSignedHeaders}\r\n`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    expect(upstreamHit).toBe(false);
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-transform', blocked: true });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });
});
