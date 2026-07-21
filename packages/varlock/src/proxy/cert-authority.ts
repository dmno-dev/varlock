import { webcrypto } from 'node:crypto';
import { isIP } from 'node:net';

import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  Certificate, TBSCertificate, Version, Validity, Name,
  RelativeDistinguishedName, AttributeTypeAndValue, AttributeValue,
  SubjectPublicKeyInfo, Extension, Extensions,
  BasicConstraints, id_ce_basicConstraints as OID_BASIC_CONSTRAINTS,
  KeyUsage, KeyUsageFlags, id_ce_keyUsage as OID_KEY_USAGE,
  ExtendedKeyUsage, id_ce_extKeyUsage as OID_EXT_KEY_USAGE, id_kp_serverAuth as OID_KP_SERVER_AUTH,
  SubjectAlternativeName, id_ce_subjectAltName as OID_SUBJECT_ALT_NAME, GeneralName,
} from '@peculiar/asn1-x509';
import { ecdsaWithSHA256, ECDSASigValue } from '@peculiar/asn1-ecc';

/**
 * In-memory ephemeral certificate authority for the MITM proxy.
 *
 * Builds X.509 certs directly from the low-level @peculiar/asn1-* ASN.1
 * structures plus the platform WebCrypto (Node/Bun native), rather than
 * @peculiar/x509 or an `openssl` subprocess. Wins:
 *  - Private keys (CA + per-host leaf) never touch disk — only the public CA
 *    cert is written out, for child trust. Closes the "same-user reads the key
 *    from /tmp" exposure, especially after a crash.
 *  - No `openssl` subprocess dependency, which matters for the `bun --compile`
 *    binary where a compatible openssl can't be assumed on the target machine.
 *  - No @peculiar/x509 prebundle (which drags in tsyringe + reflect-metadata and
 *    can't be tree-shaken). We only need self-signed CA + leaf minting, so the
 *    handful of asn1 structures used here bundle to a fraction of the size.
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

// P-256 signatures are two 32-byte integers (r, s).
const P256_POINT_SIZE = 32;

// OID for id-at-commonName (2.5.4.3), the CN attribute of a distinguished name.
const ID_AT_COMMON_NAME = '2.5.4.3';

export type EphemeralCa = {
  privateKey: CryptoKey;
  /** Issuer DN of the CA, reused as the issuer field of every minted leaf. */
  issuerName: Name;
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

/** A single-CN distinguished name (`CN=<value>`), UTF-8 encoded so IP literals with `:` are valid. */
function commonNameDn(value: string): Name {
  return new Name([
    new RelativeDistinguishedName([
      new AttributeTypeAndValue({
        type: ID_AT_COMMON_NAME,
        value: new AttributeValue({ utf8String: value }),
      }),
    ]),
  ]);
}

/** Random positive 16-byte serial number as an ASN.1 INTEGER-ready ArrayBuffer. */
function generateSerialNumber(): ArrayBuffer {
  const serial = cryptoApi.getRandomValues(new Uint8Array(16));
  // A leading bit of 1 would encode as a negative INTEGER; prepend a zero byte.
  if (serial[0] > 0x7F) {
    const prefixed = new Uint8Array(serial.length + 1);
    prefixed.set(serial, 1);
    return prefixed.buffer;
  }
  return serial.buffer as ArrayBuffer;
}

function extension(extnID: string, critical: boolean, value: unknown): Extension {
  return new Extension({ extnID, critical, extnValue: new OctetString(AsnConvert.serialize(value)) });
}

function pemEncode(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString('base64');
  const wrapped = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const pkcs8 = await cryptoApi.subtle.exportKey('pkcs8', key);
  return pemEncode('PRIVATE KEY', pkcs8);
}

// Strip leading zero bytes, then prepend one back if the top bit is set, so the
// value encodes as a positive DER INTEGER.
function trimToPositiveInteger(input: Uint8Array): ArrayBuffer {
  let bytes = input;
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  bytes = bytes.slice(i);
  if (bytes[0] > 0x7F) {
    const prefixed = new Uint8Array(bytes.length + 1);
    prefixed.set(bytes, 1);
    return prefixed.buffer;
  }
  return bytes.buffer as ArrayBuffer;
}

/** Convert a raw WebCrypto ECDSA signature (r||s) to a DER-encoded ECDSA-Sig-Value. */
function rawEcdsaToDer(raw: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(raw);
  const sig = new ECDSASigValue();
  sig.r = trimToPositiveInteger(bytes.slice(0, P256_POINT_SIZE));
  sig.s = trimToPositiveInteger(bytes.slice(P256_POINT_SIZE, P256_POINT_SIZE * 2));
  return AsnConvert.serialize(sig);
}

async function signCertificate(
  tbs: TBSCertificate,
  signingKey: CryptoKey,
): Promise<string> {
  const tbsDer = AsnConvert.serialize(tbs);
  const rawSig = await cryptoApi.subtle.sign(SIGNING_ALG, signingKey, tbsDer);
  const cert = new Certificate({
    tbsCertificate: tbs,
    signatureAlgorithm: ecdsaWithSHA256,
    signatureValue: rawEcdsaToDer(rawSig),
  });
  return pemEncode('CERTIFICATE', AsnConvert.serialize(cert));
}

async function subjectPublicKeyInfo(publicKey: CryptoKey): Promise<SubjectPublicKeyInfo> {
  const spki = await cryptoApi.subtle.exportKey('spki', publicKey);
  return AsnConvert.parse(spki, SubjectPublicKeyInfo);
}

/** Generate a fresh in-memory CA. Private key stays in memory; only the cert is exported. */
export async function createEphemeralCa(): Promise<EphemeralCa> {
  const keys = await generateKeyPair();
  const { notBefore, notAfter } = validityWindow();
  const issuerName = commonNameDn('varlock-proxy-ca');

  const tbs = new TBSCertificate({
    version: Version.v3,
    serialNumber: generateSerialNumber(),
    signature: ecdsaWithSHA256,
    issuer: issuerName,
    validity: new Validity({ notBefore, notAfter }),
    subject: issuerName,
    subjectPublicKeyInfo: await subjectPublicKeyInfo(keys.publicKey),
    extensions: new Extensions([
      extension(OID_BASIC_CONSTRAINTS, true, new BasicConstraints({ cA: true })),
      // eslint-disable-next-line no-bitwise -- combining KeyUsage flags is the intended bitmask API
      extension(OID_KEY_USAGE, true, new KeyUsage(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign)),
    ]),
  });

  const certPem = await signCertificate(tbs, keys.privateKey);
  return { privateKey: keys.privateKey, issuerName, certPem };
}

/** Mint a leaf cert for a host, signed by the CA. Both keys stay in memory. */
export async function createHostCert(ca: EphemeralCa, host: string): Promise<MintedHostCert> {
  const keys = await generateKeyPair();
  const { notBefore, notAfter } = validityWindow();

  // IP-literal hosts need an IP SAN (clients verify IPs against iPAddress, not
  // dNSName); hostnames use a DNS SAN.
  const sanEntry = isIP(host)
    ? new GeneralName({ iPAddress: host })
    : new GeneralName({ dNSName: host });

  const tbs = new TBSCertificate({
    version: Version.v3,
    serialNumber: generateSerialNumber(),
    signature: ecdsaWithSHA256,
    issuer: ca.issuerName,
    validity: new Validity({ notBefore, notAfter }),
    subject: commonNameDn(host),
    subjectPublicKeyInfo: await subjectPublicKeyInfo(keys.publicKey),
    extensions: new Extensions([
      extension(OID_BASIC_CONSTRAINTS, true, new BasicConstraints({ cA: false })),
      extension(OID_KEY_USAGE, true, new KeyUsage(KeyUsageFlags.digitalSignature)),
      extension(OID_EXT_KEY_USAGE, false, new ExtendedKeyUsage([OID_KP_SERVER_AUTH])),
      extension(OID_SUBJECT_ALT_NAME, false, new SubjectAlternativeName([sanEntry])),
    ]),
  });

  const certPem = await signCertificate(tbs, ca.privateKey);
  const keyPem = await exportPrivateKeyPem(keys.privateKey);
  return { keyPem, certPem };
}
