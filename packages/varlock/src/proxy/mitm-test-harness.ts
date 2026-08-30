import { afterAll, beforeAll } from 'vitest';
import type http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

import { createEphemeralCa, createHostCert, type EphemeralCa } from './cert-authority';

// Shared harness for the proxy's end-to-end tests: a stub HTTPS upstream, plus a
// real TLS client that reaches it through the proxy's CONNECT tunnel, trusting
// only the proxy's minted CA.
//
// Any test in which the proxy actually substitutes a secret needs this rather
// than the plain-http path, because the proxy refuses to inject into a cleartext
// connection (the cleartext guard in runtime-proxy fails closed there).

export const UPSTREAM_HOST = '127.0.0.1';

export type StubUpstream = { port: number; close: () => Promise<void> };
export type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export type MitmHarness = {
  /** Start a stub HTTPS upstream on an ephemeral port, holding a cert the proxy trusts. */
  startUpstream: (handler: UpstreamHandler) => Promise<StubUpstream>;
  /** The stub upstream's CA, for a test that needs to mint a cert of its own. */
  upstreamCa: () => EphemeralCa;
};

/**
 * Register the harness for one test file. Call it at the top level: it installs
 * the `beforeAll`/`afterAll` hooks that mint the stub upstream's CA and make the
 * proxy's outbound requests trust it.
 */
export function setupMitmHarness(): MitmHarness {
  let ca: EphemeralCa | undefined;
  let certPem = '';
  let keyPem = '';
  let restoreGlobalCa: (() => void) | undefined;

  beforeAll(async () => {
    // Stub upstream's own CA + leaf (IP SAN, since we connect by 127.0.0.1).
    ca = await createEphemeralCa();
    const leaf = await createHostCert(ca, UPSTREAM_HOST);
    certPem = leaf.certPem;
    keyPem = leaf.keyPem;

    // The proxy dials upstreams through the global agent, so add the stub CA
    // there (alongside the real roots) and restore afterwards.
    const previousCa = https.globalAgent.options.ca;
    https.globalAgent.options.ca = [...tls.rootCertificates, ca.certPem];
    restoreGlobalCa = () => {
      https.globalAgent.options.ca = previousCa;
    };
  });

  afterAll(() => {
    restoreGlobalCa?.();
  });

  return {
    startUpstream(handler: UpstreamHandler) {
      const server = https.createServer({ key: keyPem, cert: certPem }, handler);
      return new Promise<StubUpstream>((resolve) => {
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
    },
    upstreamCa() {
      if (!ca) throw new Error('mitm harness is not ready: call setupMitmHarness() at the top level of the test file');
      return ca;
    },
  };
}

/**
 * Open a CONNECT tunnel through the proxy and TLS-handshake against the proxy's
 * minted leaf, trusting only the proxy CA. Resolving at all proves CA trust.
 */
export async function openMitmTunnel(
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

/**
 * Write a raw HTTP request over the tunnel and read the response. The MITM
 * connection may stay keep-alive, so settle on idle rather than socket close.
 */
export async function sendAndRead(tlsSocket: tls.TLSSocket, rawRequest: string): Promise<string> {
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
