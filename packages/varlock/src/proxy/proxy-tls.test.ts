import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
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

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [{ source: 'attached', domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
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
      rules: [{ source: 'attached', domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
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
      rules: [{ source: 'attached', domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
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

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: REAL }],
      rules: [{ source: 'attached', domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
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
      rules: [{ source: 'attached', domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
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
        { source: 'attached', domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] },
        {
          source: 'detached', domain: [UPSTREAM_HOST], path: '/v1/charges', method: 'POST', itemKeys: [], block: true,
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
        { source: 'attached', domain: [UPSTREAM_HOST], itemKeys: ['ITEM_A'] },
        { source: 'attached', domain: ['other-host.example'], itemKeys: ['ITEM_B'] },
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
