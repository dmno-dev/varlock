// Production builds certs from the low-level @peculiar/asn1-* structures (see
// cert-authority.ts). These tests keep @peculiar/x509 as an independent oracle to
// parse and cryptographically verify what we emit. x509 v2 loads tsyringe at import
// time, which throws unless the reflect polyfill is already present.
import 'reflect-metadata';

import { describe, expect, test } from 'vitest';
import tls from 'node:tls';
import https from 'node:https';

import * as x509 from '@peculiar/x509';

import {
  createEphemeralCa, createHostCert, exportCaPrivateKeyPem, loadCa,
} from './cert-authority';

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

  test('serial numbers are minimally encoded DER INTEGERs', async () => {
    // A random serial starting with 0x00 followed by a byte with a clear top bit
    // is a non-minimal INTEGER; OpenSSL rejects it with ASN1_R_ILLEGAL_PADDING,
    // so roughly 1 in 512 minted certs used to be unloadable. Force that byte
    // pattern instead of relying on chance.
    const realGetRandomValues = crypto.getRandomValues.bind(crypto);
    const patched = (array: any) => {
      const filled = realGetRandomValues(array);
      // 16 bytes is the serial; leave key material alone.
      if (filled.length === 16) {
        filled[0] = 0x00;
        filled[1] = 0x01;
      }
      return filled;
    };

    (crypto as any).getRandomValues = patched;
    let ca: Awaited<ReturnType<typeof createEphemeralCa>>;
    let leaf: Awaited<ReturnType<typeof createHostCert>>;
    try {
      ca = await createEphemeralCa();
      leaf = await createHostCert(ca, 'api.example.com');
    } finally {
      (crypto as any).getRandomValues = realGetRandomValues;
    }

    expect(() => tls.createSecureContext({ cert: ca.certPem })).not.toThrow();
    expect(() => tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem })).not.toThrow();
    // The leading zero was dropped, not preserved.
    expect(new x509.X509Certificate(leaf.certPem).serialNumber).not.toMatch(/^00/);
  });

  test('emits PEM material and keeps no private key in the public CA cert', async () => {
    const ca = await createEphemeralCa();
    const leaf = await createHostCert(ca, 'api.example.com');

    expect(ca.certPem).toContain('BEGIN CERTIFICATE');
    expect(ca.certPem).not.toContain('PRIVATE KEY');
    expect(leaf.certPem).toContain('BEGIN CERTIFICATE');
    expect(leaf.keyPem).toContain('BEGIN PRIVATE KEY');
  });

  test('CA and leaf carry key identifiers for strict verifiers', async () => {
    // Python 3.13+ enables VERIFY_X509_STRICT by default, which rejects chains
    // missing an SKI on the CA or an AKI on the leaf (RFC 5280). A regression
    // here breaks every modern python client through the proxy.
    const ca = await createEphemeralCa();
    const leaf = await createHostCert(ca, 'api.example.com');

    const caCert = new x509.X509Certificate(ca.certPem);
    const leafCert = new x509.X509Certificate(leaf.certPem);

    const caSki = caCert.getExtension(x509.SubjectKeyIdentifierExtension);
    const leafSki = leafCert.getExtension(x509.SubjectKeyIdentifierExtension);
    const leafAki = leafCert.getExtension(x509.AuthorityKeyIdentifierExtension);
    expect(caSki).toBeTruthy();
    expect(leafSki).toBeTruthy();
    expect(leafAki).toBeTruthy();
    // Chain building matches the leaf AKI to the CA SKI byte-for-byte.
    expect(leafAki!.keyId).toBe(caSki!.keyId);
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

describe('persisted CA (proxy start --persist-ca)', () => {
  test('a reloaded CA mints leaves that still verify against the original cert', async () => {
    // What a broker restart depends on: clients keep trusting the CA they
    // already have, so the reloaded key must chain to the same cert.
    const original = await createEphemeralCa();
    const keyPem = await exportCaPrivateKeyPem(original);

    const reloaded = await loadCa(original.certPem, keyPem);
    expect(reloaded.certPem).toBe(original.certPem);
    expect(Buffer.from(reloaded.subjectKeyId)).toEqual(Buffer.from(original.subjectKeyId));

    const leaf = await createHostCert(reloaded, 'api.example.com');
    const leafCert = new x509.X509Certificate(leaf.certPem);
    // Verified against the ORIGINAL cert's public key: what a client holds.
    await expect(leafCert.verify({ publicKey: caPublicKey(original) })).resolves.toBe(true);
    expect(() => tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem })).not.toThrow();
  });

  test('exposes notAfter so an expiring persisted CA can be rotated', async () => {
    const shortLived = await createEphemeralCa(3);
    const longLived = await createEphemeralCa(30);
    expect(longLived.notAfter.getTime()).toBeGreaterThan(shortLived.notAfter.getTime());
    // survives the PEM round trip (the runtime reads it back to decide on rotation)
    const reloaded = await loadCa(longLived.certPem, await exportCaPrivateKeyPem(longLived));
    expect(Math.abs(reloaded.notAfter.getTime() - longLived.notAfter.getTime())).toBeLessThan(1000);
  });
});
