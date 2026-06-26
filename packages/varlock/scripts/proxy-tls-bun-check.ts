/**
 * Invariant #1 regression check — runs under **Bun** (the runtime the compiled
 * CLI binary uses), which the Node-based vitest suite cannot exercise.
 *
 * Bun's `https.request` flushes the request (Authorization header + body) to a
 * wrong-identity upstream *before* `checkServerIdentity` rejects — so a TLS
 * identity check that relies on the request's own pre-write gating leaks the
 * secret in the shipped binary while staying green under Node. This check proves
 * the runtime proxy:
 *   (a) injects the real secret to a correctly-identified upstream, and
 *   (b) NEVER transmits the secret to an upstream whose cert is for a different
 *       host (the DNS-poison / host-rebind case).
 *
 * Run with: bun run scripts/proxy-tls-bun-check.ts   (exits non-zero on failure)
 */
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

import { startLocalProxyRuntime } from '../src/proxy/runtime-proxy';
import { createEphemeralCa, createHostCert, type EphemeralCa } from '../src/proxy/cert-authority';

// A DNS name that resolves to loopback — avoids IP-literal SNI quirks in the
// hand-rolled test client while still exercising the real CONNECT/MITM path.
const HOST = 'localhost';
const REAL_KEY = 'sk-stub-REALKEY-must-never-leak';
const PLACEHOLDER = 'sk-stub-PLACEHOLDER';

let upstreamCa: EphemeralCa;

async function openMitmTunnel(proxyUrl: string, proxyCaPem: string, port: number): Promise<tls.TLSSocket> {
  const proxy = new URL(proxyUrl);
  const raw = net.connect(Number(proxy.port), proxy.hostname);
  await new Promise<void>((resolve, reject) => {
    raw.once('error', reject);
    raw.once('connect', () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    raw.once('data', (c: Buffer) => {
      const statusLine = c.toString('utf8').split('\r\n')[0] ?? '';
      if (/^HTTP\/1\.\d 200/.test(statusLine)) resolve();
      else reject(new Error('CONNECT failed'));
    });
    raw.write(`CONNECT ${HOST}:${port} HTTP/1.1\r\nHost: ${HOST}:${port}\r\n\r\n`);
  });
  const s = tls.connect({
    socket: raw, servername: HOST, host: HOST, ca: [proxyCaPem],
  });
  await new Promise<void>((resolve, reject) => {
    s.once('secureConnect', () => resolve());
    s.once('error', reject);
  });
  return s;
}

/** Returns whether the upstream received the REAL key in its Authorization header. */
async function runScenario(upstreamCertHost: string): Promise<boolean> {
  const leaf = await createHostCert(upstreamCa, upstreamCertHost);
  let upstreamGotRealKey = false;
  const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    if (String(req.headers.authorization ?? '').includes(REAL_KEY)) upstreamGotRealKey = true;
    res.end('ok');
  });
  server.on('tlsClientError', () => { /* a rejected upstream handshake is the point */ });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const port = (server.address() as net.AddressInfo).port;

  const runtime = await startLocalProxyRuntime({
    managedItems: [{ key: 'API_KEY', placeholder: PLACEHOLDER, realValue: REAL_KEY }],
    rules: [{ domain: [HOST], itemKeys: ['API_KEY'] }],
    egressMode: 'permissive',
  });
  const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');
  try {
    const sock = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, port);
    await new Promise<void>((resolve) => {
      let idle: ReturnType<typeof setTimeout>;
      sock.on('data', () => {
        clearTimeout(idle);
        idle = setTimeout(resolve, 250);
      });
      sock.on('close', () => resolve());
      sock.on('error', () => resolve());
      sock.write(`GET / HTTP/1.1\r\nHost: ${HOST}:${port}\r\nConnection: close\r\nAuthorization: Bearer ${PLACEHOLDER}\r\n\r\n`);
      setTimeout(resolve, 2500);
    });
  } catch { /* tunnel/handshake failure = fail-closed, which is fine */ }
  await runtime.stop();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return upstreamGotRealKey;
}

async function main() {
  if (!process.versions.bun) {
    console.error('This check must run under Bun (the compiled-binary runtime). Use: bun run scripts/proxy-tls-bun-check.ts');
    process.exit(2);
  }
  // Make the proxy's verification trust the stub upstream CA (in production these
  // are real public roots). The proxy reads https.globalAgent.options.ca.
  upstreamCa = await createEphemeralCa();
  https.globalAgent.options.ca = [...tls.rootCertificates, upstreamCa.certPem];

  const injectedToVerifiedHost = await runScenario(HOST); // cert matches → inject
  const leakedToWrongHost = await runScenario('wrong.example'); // cert mismatch → must NOT leak

  const ok = injectedToVerifiedHost && !leakedToWrongHost;
  console.log(`[bun ${process.versions.bun}] inject-to-verified-host=${injectedToVerifiedHost} (want true), leak-to-wrong-cert-host=${leakedToWrongHost} (want false)`);
  if (ok) {
    console.log('PASS: Invariant #1 holds under Bun — secret injected only to the verified upstream identity.');
    process.exit(0);
  }
  console.error('FAIL: Invariant #1 violated under Bun.');
  process.exit(1);
}

await main();
