// Production builds certs from the low-level @peculiar/asn1-* structures (see
// cert-authority.ts). These tests keep @peculiar/x509 as an independent oracle to
// parse and cryptographically verify what we emit. x509 v2 loads tsyringe at import
// time, which throws unless the reflect polyfill is already present.
import 'reflect-metadata';

import { describe, expect, test } from 'vitest';
import tls from 'node:tls';
import https from 'node:https';

import * as x509 from '@peculiar/x509';

import { createEphemeralCa, createHostCert } from './cert-authority';

/** Parse the CA's PEM with the x509 oracle to recover its public key for verification. */
function caPublicKey(ca: Awaited<ReturnType<typeof createEphemeralCa>>) {
  return new x509.X509Certificate(ca.certPem).publicKey;
}

describe('cert-authority (in-memory CA)', () => {
  test('mints a leaf that loads into Node TLS and is signed by the CA', async () => {
    const ca = await createEphemeralCa();
    const leaf = await createHostCert(ca, 'api.example.com');

    // The PEM material is accepted by Node's TLS stack (this is what
    // https.createServer consumes when MITM-ing a host).
    expect(() => tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem })).not.toThrow();

    // The leaf is cryptographically signed by the CA.
    const leafCert = new x509.X509Certificate(leaf.certPem);
    await expect(leafCert.verify({ publicKey: caPublicKey(ca) })).resolves.toBe(true);

    // Subject is the requested host.
    expect(leafCert.subject).toContain('api.example.com');
  });

  test('emits PEM material and keeps no private key in the public CA cert', async () => {
    const ca = await createEphemeralCa();
    const leaf = await createHostCert(ca, 'api.example.com');

    expect(ca.certPem).toContain('BEGIN CERTIFICATE');
    expect(ca.certPem).not.toContain('PRIVATE KEY');
    expect(leaf.certPem).toContain('BEGIN CERTIFICATE');
    expect(leaf.keyPem).toContain('BEGIN PRIVATE KEY');
  });

  test('a leaf does not verify against an unrelated CA', async () => {
    const ca = await createEphemeralCa();
    const otherCa = await createEphemeralCa();
    const leaf = await createHostCert(ca, 'api.example.com');

    const leafCert = new x509.X509Certificate(leaf.certPem);
    await expect(leafCert.verify({ publicKey: caPublicKey(otherCa) })).resolves.toBe(false);
  });

  // The proxy-tls e2e test covers the IP-literal SAN branch (127.0.0.1). This
  // covers the dNSName branch: a client doing full hostname verification against
  // the CA must accept a leaf minted for that hostname.
  test('a DNS-host leaf passes Node TLS hostname verification against the CA', async () => {
    const ca = await createEphemeralCa();
    const host = 'api.example.com';
    const leaf = await createHostCert(ca, host);

    const server = https.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      (_req, res) => res.end('ok'),
    );
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as import('node:net').AddressInfo;

    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = https.get({
          host: '127.0.0.1',
          port,
          // Present the DNS hostname for SNI + verification while connecting to loopback.
          servername: host,
          ca: ca.certPem,
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(host, cert),
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
      });
      expect(body).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
