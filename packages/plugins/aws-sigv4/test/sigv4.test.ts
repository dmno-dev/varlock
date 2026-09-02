import { describe, expect, test } from 'vitest';
import crypto from 'node:crypto';

import { parseSigv4InboundScope, signAwsSigv4Transform, type AwsSigv4TransformOptions } from '../src/sigv4';

const sha256hex = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

const EMPTY_SHA256 = sha256hex('');

// The AWS docs signing example: keys, host, and instant from
// https://docs.aws.amazon.com/general/latest/gr/sigv4-create-signed-request.html
const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const SIGNING_INSTANT_MS = Date.UTC(2015, 7, 30, 12, 36, 0);
const AMZ_DATE = '20150830T123600Z';
const DATE_STAMP = '20150830';

/** A placeholder-signed inbound Authorization header carrying the given scope. */
function placeholderAuthHeader(region: string, service: string): string {
  return `AWS4-HMAC-SHA256 Credential=VLKPLACEHOLDERKEY/${DATE_STAMP}/${region}/${service}/aws4_request, `
    + 'SignedHeaders=host;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000';
}

const BASE_TRANSFORM = {
  scheme: 'aws-sigv4',
  secretKey: { itemRef: 'AWS_SECRET_ACCESS_KEY' },
  keyId: { itemRef: 'AWS_ACCESS_KEY_ID' },
} satisfies AwsSigv4TransformOptions;

const BASE_CREDENTIALS = { secretKey: SECRET_KEY, keyId: ACCESS_KEY };

const iamInput = {
  method: 'GET',
  host: 'iam.amazonaws.com',
  path: '/',
  query: 'Action=ListUsers&Version=2010-05-08',
  headers: {
    host: 'iam.amazonaws.com',
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    authorization: placeholderAuthHeader('us-east-1', 'iam'),
    'x-amz-date': '20140101T000000Z', // stale child-set date - must be replaced
  },
  body: Buffer.alloc(0),
  credentials: BASE_CREDENTIALS,
};

describe('parseSigv4InboundScope', () => {
  test('parses region and service from the Authorization credential scope', () => {
    expect(parseSigv4InboundScope(placeholderAuthHeader('us-east-1', 'iam'), '')).toEqual({
      ok: true, scope: { region: 'us-east-1', service: 'iam' },
    });
  });

  test('rejects a non-SigV4 Authorization header', () => {
    const parsed = parseSigv4InboundScope('Bearer some-token', '');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('not a AWS4-HMAC-SHA256 signature');
  });

  test('rejects a malformed credential scope', () => {
    const parsed = parseSigv4InboundScope('AWS4-HMAC-SHA256 Credential=KEY/only-two, Signature=x', '');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('malformed SigV4 credential scope');
  });

  test('flags pre-signed URLs (X-Amz-Credential in query) as unsupported', () => {
    const parsed = parseSigv4InboundScope(undefined, `X-Amz-Credential=${encodeURIComponent('KEY/20150830/us-east-1/s3/aws4_request')}&X-Amz-Signature=abc`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.presigned).toBe(true);
  });

  test('explains the placeholder-signing setup when no signature is present', () => {
    const parsed = parseSigv4InboundScope(undefined, '');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('Configure the AWS SDK with the placeholder credentials');
  });
});

describe('signAwsSigv4Transform', () => {
  test('re-signs with the real keys, matching an independent SigV4 computation', async () => {
    const result = await signAwsSigv4Transform(BASE_TRANSFORM, iamInput, SIGNING_INSTANT_MS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removeHeaders).toContain('authorization');
    expect(result.setHeaders['x-amz-date']).toBe(AMZ_DATE);
    expect(result.setHeaders['x-amz-content-sha256']).toBe(EMPTY_SHA256);
    expect(result.setHeaders.authorization).toContain(`Credential=${ACCESS_KEY}/${DATE_STAMP}/us-east-1/iam/aws4_request`);
    expect(result.setHeaders.authorization).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date');

    // Independent computation per the SigV4 spec (node:crypto only, no smithy):
    // canonical request -> string to sign -> derived key -> signature.
    const canonicalRequest = [
      'GET',
      '/',
      'Action=ListUsers&Version=2010-05-08',
      'content-type:application/x-www-form-urlencoded; charset=utf-8',
      'host:iam.amazonaws.com',
      `x-amz-content-sha256:${EMPTY_SHA256}`,
      `x-amz-date:${AMZ_DATE}`,
      '',
      'content-type;host;x-amz-content-sha256;x-amz-date',
      EMPTY_SHA256,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      AMZ_DATE,
      `${DATE_STAMP}/us-east-1/iam/aws4_request`,
      sha256hex(canonicalRequest),
    ].join('\n');
    const kDate = hmac(`AWS4${SECRET_KEY}`, DATE_STAMP);
    const kRegion = hmac(kDate, 'us-east-1');
    const kService = hmac(kRegion, 'iam');
    const kSigning = hmac(kService, 'aws4_request');
    const expectedSignature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    expect(result.setHeaders.authorization).toContain(`Signature=${expectedSignature}`);
  });

  test('hashes the outbound body bytes and includes a session token when configured', async () => {
    const body = Buffer.from('{"TableName":"widgets"}', 'utf8');
    const result = await signAwsSigv4Transform(
      { ...BASE_TRANSFORM, sessionToken: { itemRef: 'AWS_SESSION_TOKEN' } },
      {
        ...iamInput,
        method: 'POST',
        host: 'dynamodb.us-west-2.amazonaws.com',
        query: '',
        headers: {
          host: 'dynamodb.us-west-2.amazonaws.com',
          authorization: placeholderAuthHeader('us-west-2', 'dynamodb'),
        },
        body,
        credentials: { ...BASE_CREDENTIALS, sessionToken: 'the-session-token' },
      },
      SIGNING_INSTANT_MS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setHeaders['x-amz-content-sha256']).toBe(sha256hex(body));
    expect(result.setHeaders['x-amz-security-token']).toBe('the-session-token');
    expect(result.setHeaders.authorization).toContain('x-amz-security-token');
  });

  test('hashes exact binary body bytes (no text round-trip)', async () => {
    const binaryBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const result = await signAwsSigv4Transform(BASE_TRANSFORM, {
      ...iamInput,
      method: 'PUT',
      host: 'bucket.s3.amazonaws.com',
      path: '/object.png',
      query: '',
      headers: { host: 'bucket.s3.amazonaws.com', authorization: placeholderAuthHeader('us-east-1', 's3') },
      body: binaryBody,
    }, SIGNING_INSTANT_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setHeaders['x-amz-content-sha256']).toBe(sha256hex(binaryBody));
  });

  test('preserves an UNSIGNED-PAYLOAD sentinel the client signed with', async () => {
    const result = await signAwsSigv4Transform(BASE_TRANSFORM, {
      ...iamInput,
      headers: { ...iamInput.headers, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      body: Buffer.from('streaming-body-not-hashed'),
    }, SIGNING_INSTANT_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setHeaders['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
  });

  test('fails closed on aws-chunked STREAMING-* payloads instead of mis-signing them', async () => {
    const result = await signAwsSigv4Transform(BASE_TRANSFORM, {
      ...iamInput,
      headers: {
        ...iamInput.headers,
        'content-encoding': 'aws-chunked',
        'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
      },
      body: Buffer.from('chunk-framed-bytes'),
    }, SIGNING_INSTANT_MS);
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toContain('cannot be re-signed');
  });

  test('gates on allowedRegions / allowedServices', async () => {
    const regionBlocked = await signAwsSigv4Transform({ ...BASE_TRANSFORM, allowedRegions: ['eu-west-1'] }, iamInput, SIGNING_INSTANT_MS);
    expect(regionBlocked).toMatchObject({ ok: false, status: 403 });

    const serviceBlocked = await signAwsSigv4Transform({ ...BASE_TRANSFORM, allowedServices: ['bedrock'] }, iamInput, SIGNING_INSTANT_MS);
    expect(serviceBlocked).toMatchObject({ ok: false, status: 403 });
  });

  test('fails with a setup pointer when the child did not sign', async () => {
    const { authorization: _dropped, ...headersWithoutAuth } = iamInput.headers;
    const result = await signAwsSigv4Transform(BASE_TRANSFORM, {
      ...iamInput, headers: headersWithoutAuth,
    }, SIGNING_INSTANT_MS);
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toContain('Configure the AWS SDK');
  });
});
