import { describe, expect, test } from 'vitest';
import tls from 'node:tls';

import * as x509 from '@peculiar/x509';

import { createEphemeralCa, createHostCert } from './cert-authority';

describe('cert-authority (in-memory CA)', () => {
  test('mints a leaf that loads into Node TLS and is signed by the CA', async () => {
    const ca = await createEphemeralCa();
    const leaf = await createHostCert(ca, 'api.example.com');

    // The PEM material is accepted by Node's TLS stack (this is what
    // https.createServer consumes when MITM-ing a host).
    expect(() => tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem })).not.toThrow();

    // The leaf is cryptographically signed by the CA.
    const leafCert = new x509.X509Certificate(leaf.certPem);
    await expect(leafCert.verify({ publicKey: ca.cert.publicKey })).resolves.toBe(true);

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
    await expect(leafCert.verify({ publicKey: otherCa.cert.publicKey })).resolves.toBe(false);
  });
});
