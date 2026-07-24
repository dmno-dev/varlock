// @peculiar/x509 v2 loads tsyringe at import time, which throws unless the reflect
// polyfill is already present. Production loads it first via cert-authority's lazy
// loader; this test imports x509 statically, so it must pull the polyfill first too.
import 'reflect-metadata';

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
    await expect(leafCert.verify({ publicKey: otherCa.cert.publicKey })).resolves.toBe(false);
  });
});
