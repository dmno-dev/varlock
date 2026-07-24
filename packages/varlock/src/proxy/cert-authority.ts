import { webcrypto } from 'node:crypto';
import { isIP } from 'node:net';

import type * as X509 from '@peculiar/x509';

/**
 * In-memory ephemeral certificate authority for the MITM proxy.
 *
 * Uses @peculiar/x509 over the platform WebCrypto (Node/Bun native) rather than
 * shelling out to `openssl`. Two wins over the old approach:
 *  - Private keys (CA + per-host leaf) never touch disk — only the public CA
 *    cert is written out, for child trust. Closes the "same-user reads the key
 *    from /tmp" exposure, especially after a crash.
 *  - No `openssl` subprocess dependency, which matters for the `bun --compile`
 *    binary where a compatible openssl can't be assumed on the target machine.
 *
 * EC P-256 is used throughout: leaf certs are minted per-host on first CONNECT
 * (in the request hot path), and EC keygen is ~milliseconds vs RSA-2048's tens
 * to hundreds. API clients (Node, python, curl, git) all accept ECDSA P-256.
 */

// Prefer the global WebCrypto (present in Bun and Node 18+); fall back to the
// node:crypto webcrypto export for older Node.
const cryptoApi: Crypto = (globalThis.crypto as Crypto | undefined) ?? (webcrypto as unknown as Crypto);

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;
const VALIDITY_DAYS = 3;

// @peculiar/x509's bundled build uses tsyringe, which requires the
// reflect-metadata polyfill to be present before it initializes. Static import
// order isn't preserved through bundling (the binary reorders module init), so
// we load both lazily via dynamic import and await reflect-metadata first — the
// await sequence guarantees the polyfill is applied before x509 initializes.
let x509Promise: Promise<typeof import('@peculiar/x509')> | undefined;
async function loadX509(): Promise<typeof import('@peculiar/x509')> {
  x509Promise ||= (async () => {
    await import('reflect-metadata');
    const mod = await import('@peculiar/x509');
    mod.cryptoProvider.set(cryptoApi);
    return mod;
  })();
  return x509Promise;
}

export type EphemeralCa = {
  privateKey: CryptoKey;
  cert: X509.X509Certificate;
  certPem: string;
};

export type MintedHostCert = {
  keyPem: string;
  certPem: string;
};

function validityWindow(): { notBefore: Date; notAfter: Date } {
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  return { notBefore, notAfter };
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return cryptoApi.subtle.generateKey(KEY_ALG, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const pkcs8 = await cryptoApi.subtle.exportKey('pkcs8', key);
  const b64 = Buffer.from(pkcs8).toString('base64');
  const wrapped = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

/** Generate a fresh in-memory CA. Private key stays in memory; only the cert is exported. */
export async function createEphemeralCa(): Promise<EphemeralCa> {
  const x509 = await loadX509();
  const keys = await generateKeyPair();
  const { notBefore, notAfter } = validityWindow();

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=varlock-proxy-ca',
    notBefore,
    notAfter,
    keys,
    signingAlgorithm: SIGNING_ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      // eslint-disable-next-line no-bitwise -- combining KeyUsage flags is the intended bitmask API
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      // RFC 5280 requires an SKI on CA certs; strict verifiers (python 3.13+
      // sets VERIFY_X509_STRICT by default) reject chains without it.
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });

  return { privateKey: keys.privateKey, cert, certPem: cert.toString('pem') };
}

/** Mint a leaf cert for a host, signed by the CA. Both keys stay in memory. */
export async function createHostCert(ca: EphemeralCa, host: string): Promise<MintedHostCert> {
  const x509 = await loadX509();
  const keys = await generateKeyPair();
  const { notBefore, notAfter } = validityWindow();

  const cert = await x509.X509CertificateGenerator.create({
    subject: `CN=${host}`,
    issuer: ca.cert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: SIGNING_ALG,
    publicKey: keys.publicKey,
    signingKey: ca.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      // IP-literal hosts need an IP SAN (clients verify IPs against iPAddress,
      // not dNSName); hostnames use a DNS SAN.
      new x509.SubjectAlternativeNameExtension([{ type: isIP(host) ? 'ip' : 'dns', value: host }]),
      // Strict verifiers (python 3.13+ sets VERIFY_X509_STRICT by default)
      // require an AKI on non-self-issued certs; it must match the CA's SKI,
      // which both being derived from the CA public key guarantees.
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(ca.cert.publicKey),
    ],
  });

  const keyPem = await exportPrivateKeyPem(keys.privateKey);
  return { keyPem, certPem: cert.toString('pem') };
}
