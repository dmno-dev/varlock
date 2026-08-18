/**
 * Tests for jwt_bearer assertion building/signing.
 */

import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { parseServiceAccountKey, buildJwtBearerAssertion } from '../oauth-jwt';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function decodeSegment(segment: string) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString());
}

describe('parseServiceAccountKey', () => {
  it('extracts issuer, key, and token url from a google-style key file', () => {
    const material = parseServiceAccountKey(JSON.stringify({
      type: 'service_account',
      client_email: 'sa@project.iam.gserviceaccount.com',
      private_key: PRIVATE_KEY_PEM,
      token_uri: 'https://oauth2.googleapis.com/token',
    }));
    expect(material.issuer).toBe('sa@project.iam.gserviceaccount.com');
    expect(material.privateKeyPem).toBe(PRIVATE_KEY_PEM);
    expect(material.tokenUrl).toBe('https://oauth2.googleapis.com/token');
  });

  it('rejects non-JSON and non-key-file shapes without echoing contents', () => {
    expect(() => parseServiceAccountKey('not json')).toThrow(/not valid JSON/);
    const err = (() => {
      try {
        parseServiceAccountKey(JSON.stringify({ some: 'secret-thing' }));
        return undefined;
      } catch (e) { return e as Error; }
    })();
    expect(err?.message).toMatch(/missing client_email/);
    expect(err?.message).not.toContain('secret-thing');
  });
});

describe('buildJwtBearerAssertion', () => {
  const keyMaterial = { issuer: 'sa@project.iam', privateKeyPem: PRIVATE_KEY_PEM };

  it('produces a valid RS256 JWT with the expected claims', () => {
    const assertion = buildJwtBearerAssertion({
      keyMaterial,
      audience: 'https://example.com/token',
      scope: 'a b',
    });
    const [headerSeg, claimsSeg, sigSeg] = assertion.split('.');
    expect(decodeSegment(headerSeg)).toEqual({ alg: 'RS256', typ: 'JWT' });

    const claims = decodeSegment(claimsSeg);
    expect(claims.iss).toBe('sa@project.iam');
    expect(claims.aud).toBe('https://example.com/token');
    expect(claims.scope).toBe('a b');
    expect(claims.sub).toBeUndefined();
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(claims.iat).toBeLessThanOrEqual(nowSeconds);
    expect(claims.exp).toBeGreaterThan(nowSeconds);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

    const verified = cryptoVerify(
      'sha256',
      Buffer.from(`${headerSeg}.${claimsSeg}`),
      publicKey,
      Buffer.from(sigSeg, 'base64url'),
    );
    expect(verified).toBe(true);
  });

  it('includes the subject claim when impersonating', () => {
    const assertion = buildJwtBearerAssertion({
      keyMaterial: { ...keyMaterial, subject: 'user@example.com' },
      audience: 'https://example.com/token',
    });
    expect(decodeSegment(assertion.split('.')[1]).sub).toBe('user@example.com');
  });

  it('rejects invalid and non-RSA keys', () => {
    expect(() => buildJwtBearerAssertion({
      keyMaterial: { issuer: 'x', privateKeyPem: 'not a pem' },
      audience: 'https://example.com/token',
    })).toThrow(/not a valid PEM/);

    const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => buildJwtBearerAssertion({
      keyMaterial: { issuer: 'x', privateKeyPem: ecKey },
      audience: 'https://example.com/token',
    })).toThrow(/only RSA/);
  });
});
