import { describe, expect, test } from 'vitest';
import crypto from 'node:crypto';

import {
  BUILT_IN_TRANSFORM_SCHEMES,
  buildStringToSign, computeHmacTransform, computeTransformTimestamp, decodeTransformKey,
} from './request-transform';
import type { ProxyRuleHmacTransform } from './types';

const NOW_MS = 1755111845123; // fixed instant so every timestamp assertion is exact

describe('computeTransformTimestamp', () => {
  test('formats', () => {
    expect(computeTransformTimestamp(undefined, NOW_MS)).toBe('1755111845'); // default unix-seconds
    expect(computeTransformTimestamp('unix-seconds', NOW_MS)).toBe('1755111845');
    expect(computeTransformTimestamp('unix-millis', NOW_MS)).toBe('1755111845123');
    expect(computeTransformTimestamp('unix-nanos', NOW_MS)).toBe('1755111845123000000');
    expect(computeTransformTimestamp('rfc3339', NOW_MS)).toBe(new Date(NOW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  });
});

describe('buildStringToSign', () => {
  const fields = {
    timestamp: 'TS', method: 'POST', path: '/orders', query: 'limit=5', host: 'api.example.com', body: '{"a":1}',
  };

  test('expands every field', () => {
    expect(buildStringToSign('{timestamp}|{method}|{path}|{pathWithQuery}|{query}|{host}|{body}', fields))
      .toBe('TS|POST|/orders|/orders?limit=5|limit=5|api.example.com|{"a":1}');
  });

  test('pathWithQuery omits the ? when there is no query', () => {
    expect(buildStringToSign('{pathWithQuery}', { ...fields, query: '' })).toBe('/orders');
  });

  test('a brace sequence that is not a known field passes through untouched', () => {
    // (schema validation rejects unknown {field}s; body text with braces like
    // JSON must never be treated as a template field)
    expect(buildStringToSign('{method}{"raw":1}', fields)).toBe('POST{"raw":1}');
  });
});

describe('decodeTransformKey', () => {
  test('raw (default) uses utf8 bytes as-is', () => {
    expect(decodeTransformKey('secret', undefined)).toEqual(Buffer.from('secret', 'utf8'));
    expect(decodeTransformKey('secret', 'raw')).toEqual(Buffer.from('secret', 'utf8'));
  });

  test('hex decodes valid input and rejects malformed input', () => {
    expect(decodeTransformKey('deadBEEF', 'hex')).toEqual(Buffer.from('deadbeef', 'hex'));
    expect(decodeTransformKey('xyz', 'hex')).toBeUndefined();
    expect(decodeTransformKey('abc', 'hex')).toBeUndefined(); // odd length
  });

  test('base64 decodes valid input and rejects malformed input', () => {
    expect(decodeTransformKey('c2VjcmV0', 'base64')).toEqual(Buffer.from('secret', 'utf8'));
    expect(decodeTransformKey('!!!!', 'base64')).toBeUndefined();
    expect(decodeTransformKey('abc', 'base64')).toBeUndefined(); // bad padding/length
  });
});

describe('computeHmacTransform', () => {
  const baseTransform: ProxyRuleHmacTransform = {
    scheme: 'hmac-sha256',
    secretKey: 'SECRET',
    stringToSign: '{body}',
    signatureHeader: 'x-signature',
  };
  const fields = {
    method: 'GET', host: 'api.example.com', path: '/', query: '', body: 'The quick brown fox jumps over the lazy dog',
  };

  test('matches the classic HMAC-SHA256 test vector (hex)', () => {
    const result = computeHmacTransform({ ...baseTransform, encoding: 'hex' }, 'key', fields, NOW_MS);
    expect(result).toMatchObject({
      ok: true,
      signature: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    });
  });

  test('defaults to base64 output', () => {
    const result = computeHmacTransform(baseTransform, 'key', fields, NOW_MS);
    expect(result).toMatchObject({
      ok: true,
      signature: Buffer.from('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8', 'hex').toString('base64'),
    });
  });

  test('hmac-sha512 uses the sha512 digest', () => {
    const result = computeHmacTransform({ ...baseTransform, scheme: 'hmac-sha512', encoding: 'hex' }, 'key', fields, NOW_MS);
    const expected = crypto.createHmac('sha512', 'key').update(fields.body, 'utf8').digest('hex');
    expect(result).toMatchObject({ ok: true, signature: expected });
  });

  test('a composite venue-style template signs timestamp+method+path+body', () => {
    const transform: ProxyRuleHmacTransform = {
      ...baseTransform,
      stringToSign: '{timestamp}{method}{pathWithQuery}{body}',
      encoding: 'hex',
    };
    const reqFields = {
      ...fields, method: 'POST', path: '/orders', query: 'limit=5', body: '{"size":1}',
    };
    const result = computeHmacTransform(transform, 'shhh', reqFields, NOW_MS);
    const expected = crypto.createHmac('sha256', 'shhh')
      .update('1755111845POST/orders?limit=5{"size":1}', 'utf8')
      .digest('hex');
    expect(result).toMatchObject({ ok: true, signature: expected, timestamp: '1755111845' });
  });

  test('keyEncoding decodes the secret before keying (Coinbase-style base64 keys)', () => {
    const rawKey = crypto.randomBytes(32);
    const transform: ProxyRuleHmacTransform = { ...baseTransform, keyEncoding: 'base64', encoding: 'hex' };
    const result = computeHmacTransform(transform, rawKey.toString('base64'), fields, NOW_MS);
    const expected = crypto.createHmac('sha256', rawKey).update(fields.body, 'utf8').digest('hex');
    expect(result).toMatchObject({ ok: true, signature: expected });
  });

  test('fails closed on a secret that is not valid for its keyEncoding', () => {
    const result = computeHmacTransform({ ...baseTransform, keyEncoding: 'hex' }, 'not-hex!', fields, NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid hex');
  });
});

describe('http-basic signer', () => {
  const sign = BUILT_IN_TRANSFORM_SCHEMES['http-basic'].sign;
  const input = {
    method: 'GET',
    host: 'api.example.com',
    path: '/',
    query: '',
    body: Buffer.alloc(0),
    headers: { authorization: 'Basic Z2FyYmFnZTpwbGFjZWhvbGRlcg==' },
    credentials: { secretKey: 'real-password' },
  };
  const transform = { scheme: 'http-basic', secretKey: 'API_PASSWORD', username: 'svc-user' };

  test('writes Basic base64(user:realsecret), overwriting the child header', async () => {
    const result = await sign(transform as any, input as any, NOW_MS);
    expect(result).toMatchObject({
      ok: true,
      setHeaders: { authorization: `Basic ${Buffer.from('svc-user:real-password').toString('base64')}` },
    });
  });

  test('a $NAME-marked username resolves via credentials (item reference)', async () => {
    const result = await sign(
      { scheme: 'http-basic', secretKey: 'API_PASSWORD', username: '$API_USER' } as any,
      { ...input, credentials: { secretKey: 'real-password', username: 'item-user' } } as any,
      NOW_MS,
    );
    expect(result).toMatchObject({
      ok: true,
      setHeaders: { authorization: `Basic ${Buffer.from('item-user:real-password').toString('base64')}` },
    });
  });

  test('defaults to an empty username when none is configured', async () => {
    const result = await sign({ scheme: 'http-basic', secretKey: 'API_PASSWORD' } as any, input as any, NOW_MS);
    expect(result).toMatchObject({
      ok: true,
      setHeaders: { authorization: `Basic ${Buffer.from(':real-password').toString('base64')}` },
    });
  });

  test('secretIn="username" puts the secret in the userid position with an empty password', async () => {
    const result = await sign(
      { scheme: 'http-basic', secretKey: 'API_TOKEN', secretIn: 'username' } as any,
      { ...input, credentials: { secretKey: 'the-token' } } as any,
      NOW_MS,
    );
    expect(result).toMatchObject({
      ok: true,
      setHeaders: { authorization: `Basic ${Buffer.from('the-token:').toString('base64')}` },
    });
  });

  test('secretIn="username" with a literal password composes secret:literal', async () => {
    const result = await sign(
      {
        scheme: 'http-basic', secretKey: 'GH_TOKEN', secretIn: 'username', password: 'x-oauth-basic',
      } as any,
      { ...input, credentials: { secretKey: 'the-token' } } as any,
      NOW_MS,
    );
    expect(result).toMatchObject({
      ok: true,
      setHeaders: { authorization: `Basic ${Buffer.from('the-token:x-oauth-basic').toString('base64')}` },
    });
  });

  test('fails closed on a userid containing ":" (including a secret in username position)', async () => {
    const result = await sign(
      { scheme: 'http-basic', secretKey: 'API_TOKEN', secretIn: 'username' } as any,
      { ...input, credentials: { secretKey: 'evil:token' } } as any,
      NOW_MS,
    );
    expect(result.ok).toBe(false);
  });
});
