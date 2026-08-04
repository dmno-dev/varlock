/**
 * JWT assertion building/signing for the OAuth jwt_bearer grant (RFC 7523).
 *
 * The dominant use is Google service accounts: the downloaded JSON key holds a
 * private key that signs a short-lived assertion, exchanged at the token
 * endpoint for an access token. No refresh token exists in this flow - the
 * key is the credential.
 *
 * RS256 only for now (covers Google, Salesforce, Box). ES256 needs DER-to-JOSE
 * signature conversion - add it when a real provider requires it.
 *
 * Error messages here must never echo key material.
 */

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

/** default assertion lifetime - only bounds the exchange window, not the resulting token */
const DEFAULT_ASSERTION_LIFETIME_SECONDS = 300;
/** backdate iat slightly so minor clock drift doesn't invalidate the assertion */
const CLOCK_SKEW_SECONDS = 30;

export type JwtBearerKeyMaterial = {
  /** `iss` claim - the identity doing the signing (e.g. service account email) */
  issuer: string;
  /** `sub` claim - identity to impersonate, when the provider supports it */
  subject?: string;
  privateKeyPem: string;
  /** token endpoint discovered from a service account key file, used when the schema doesn't set one */
  tokenUrl?: string;
};

function base64UrlJson(value: any): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Parses a Google-style service account key JSON (`client_email`, `private_key`,
 * `token_uri`). Throws on anything else; never echoes file contents.
 */
export function parseServiceAccountKey(keyJson: string): JwtBearerKeyMaterial {
  let parsed: any;
  try {
    parsed = JSON.parse(keyJson);
  } catch {
    throw new Error('serviceAccountKey is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('serviceAccountKey must be a JSON object');
  }
  if (typeof parsed.client_email !== 'string' || !parsed.client_email) {
    throw new Error('serviceAccountKey is missing client_email - expected a service account key file');
  }
  if (typeof parsed.private_key !== 'string' || !parsed.private_key) {
    throw new Error('serviceAccountKey is missing private_key - expected a service account key file');
  }
  return {
    issuer: parsed.client_email,
    privateKeyPem: parsed.private_key,
    tokenUrl: typeof parsed.token_uri === 'string' && parsed.token_uri ? parsed.token_uri : undefined,
  };
}

/**
 * Builds and signs the RS256 assertion JWT.
 * `scope` goes into the claims (Google reads it there); callers may also send
 * it as a form param, which RFC 7523 servers that ignore the claim expect.
 */
export function buildJwtBearerAssertion(opts: {
  keyMaterial: JwtBearerKeyMaterial;
  /** `aud` claim - the token endpoint unless overridden */
  audience: string;
  scope?: string;
  lifetimeSeconds?: number;
}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: Record<string, string | number> = {
    iss: opts.keyMaterial.issuer,
    aud: opts.audience,
    iat: nowSeconds - CLOCK_SKEW_SECONDS,
    exp: nowSeconds + (opts.lifetimeSeconds ?? DEFAULT_ASSERTION_LIFETIME_SECONDS),
  };
  if (opts.keyMaterial.subject) claims.sub = opts.keyMaterial.subject;
  if (opts.scope) claims.scope = opts.scope;

  const signingInput = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson(claims)}`;

  let privateKey;
  try {
    privateKey = createPrivateKey(opts.keyMaterial.privateKeyPem);
  } catch {
    throw new Error('private key is not a valid PEM key');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error(`private key type "${privateKey.asymmetricKeyType}" is not supported - only RSA (RS256) keys work with the jwt_bearer grant currently`);
  }

  // node's default RSA signing is PKCS#1 v1.5, which is what RS256 means
  const signature = cryptoSign('sha256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}
