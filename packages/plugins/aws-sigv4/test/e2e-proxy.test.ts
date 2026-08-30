import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

// Cross-package source imports (test-only): the proxy runtime is not part of
// varlock's public export map, and this integration test deliberately runs the
// REAL sigv4 signer through the REAL MITM pipeline.
import { startLocalProxyRuntime } from '../../../varlock/src/proxy/runtime-proxy';
import { createEphemeralCa, createHostCert, type EphemeralCa } from '../../../varlock/src/proxy/cert-authority';
import { signAwsSigv4Transform } from '../src/sigv4';

const UPSTREAM_HOST = '127.0.0.1';
let upstreamCa: EphemeralCa;
let upstreamCertPem: string;
let upstreamKeyPem: string;
let restoreGlobalCa: () => void;

beforeAll(async () => {
  upstreamCa = await createEphemeralCa();
  const leaf = await createHostCert(upstreamCa, UPSTREAM_HOST);
  upstreamCertPem = leaf.certPem;
  upstreamKeyPem = leaf.keyPem;
  const previousCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = [...tls.rootCertificates, upstreamCa.certPem];
  restoreGlobalCa = () => {
    https.globalAgent.options.ca = previousCa;
  };
});

afterAll(() => {
  restoreGlobalCa?.();
});

function startUpstream(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const server = https.createServer({ key: upstreamKeyPem, cert: upstreamCertPem }, handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, UPSTREAM_HOST, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no upstream addr');
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => {
          server.close(() => r());
        }),
      });
    });
  });
}

async function openMitmTunnel(proxyUrl: string, proxyCaPem: string, targetPort: number): Promise<tls.TLSSocket> {
  const proxy = new URL(proxyUrl);
  const rawSocket = net.connect(Number(proxy.port), proxy.hostname);
  await new Promise<void>((resolve, reject) => {
    rawSocket.once('error', reject);
    rawSocket.once('connect', () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    rawSocket.once('data', (chunk: Buffer) => {
      const statusLine = chunk.toString('utf8').split('\r\n')[0] ?? '';
      if (/^HTTP\/1\.\d 200/.test(statusLine)) resolve();
      else reject(new Error(`CONNECT failed: ${statusLine}`));
    });
    rawSocket.write(`CONNECT ${UPSTREAM_HOST}:${targetPort} HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${targetPort}\r\n\r\n`);
  });
  const tlsSocket = tls.connect({ socket: rawSocket, host: UPSTREAM_HOST, ca: [proxyCaPem] });
  await new Promise<void>((resolve, reject) => {
    tlsSocket.once('error', reject);
    tlsSocket.once('secureConnect', () => {
      if (tlsSocket.authorized) resolve();
      else reject(tlsSocket.authorizationError ?? new Error('client did not authorize proxy leaf'));
    });
  });
  return tlsSocket;
}

async function sendAndRead(tlsSocket: tls.TLSSocket, rawRequest: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    let idle: ReturnType<typeof setTimeout>;
    tlsSocket.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      clearTimeout(idle);
      idle = setTimeout(() => resolve(buf), 250);
    });
    tlsSocket.on('end', () => resolve(buf));
    tlsSocket.on('error', reject);
    tlsSocket.write(rawRequest);
  });
}

const SIGV4_SCHEME_DEF = {
  options: {
    keyId: { required: true, type: 'string', itemRole: 'wire' },
    sessionToken: { type: 'string', itemRole: 'wire' },
    allowedRegions: { type: 'stringList' },
    allowedServices: { type: 'stringList' },
  },
  sign: signAwsSigv4Transform,
} as any;

describe('aws-sigv4 re-signing through the real proxy MITM pipeline', () => {
  test('re-signs with real keys; the signature verifies against an independent SigV4 computation over the received bytes', async () => {
    let upstreamHeaders: import('node:http').IncomingHttpHeaders = {};
    let upstreamBody = '';
    const upstream = await startUpstream((req, res) => {
      upstreamHeaders = req.headers;
      req.on('data', (c: Buffer) => {
        upstreamBody += c.toString('utf8');
      });
      req.on('end', () => {
        res.statusCode = 200;
        res.end('{}');
      });
    });

    const activities: Array<any> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [
        { key: 'AWS_SECRET_ACCESS_KEY', placeholder: 'vlk_ph_aws_secret', realValue: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYREALKEY' },
        { key: 'AWS_ACCESS_KEY_ID', placeholder: 'VLKPLACEHOLDERAKID', realValue: 'AKIDREALKEY' },
      ],
      rules: [
        {
          domain: [UPSTREAM_HOST],
          itemKeys: ['AWS_ACCESS_KEY_ID'],
          transform: { scheme: 'aws-sigv4', secretKey: { itemRef: 'AWS_SECRET_ACCESS_KEY' }, keyId: { itemRef: 'AWS_ACCESS_KEY_ID' } },
        },
      ],
      transformSchemes: { 'aws-sigv4': SIGV4_SCHEME_DEF },
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const payload = '{"TableName":"widgets"}';
    const response = await sendAndRead(
      tlsSocket,
      `POST /prod/items?limit=2 HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + 'Authorization: AWS4-HMAC-SHA256 Credential=VLKPLACEHOLDERAKID/20260101/us-east-1/execute-api/aws4_request, '
        + 'SignedHeaders=host;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000\r\n'
        + 'X-Amz-Date: 20260101T000000Z\r\n'
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );
    expect(response.split('\r\n')[0]).toContain('200');

    const authorization = String(upstreamHeaders.authorization);
    const amzDate = String(upstreamHeaders['x-amz-date']);
    const dateStamp = amzDate.slice(0, 8);
    expect(authorization).toContain(`Credential=AKIDREALKEY/${dateStamp}/us-east-1/execute-api/aws4_request`);
    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);
    expect(amzDate).not.toBe('20260101T000000Z');
    const payloadHash = createHash('sha256').update(upstreamBody).digest('hex');
    expect(upstreamHeaders['x-amz-content-sha256']).toBe(payloadHash);
    expect(upstreamBody).toBe(payload);

    // Independent spec-derived verification over EXACTLY what the upstream
    // received: rebuild the canonical request from the SignedHeaders list and
    // recompute the signature with node:crypto only.
    const signedHeaderNames = authorization.match(/SignedHeaders=([^,]+),/)![1].split(';');
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${String(upstreamHeaders[name]).trim()}`)
      .join('\n');
    const canonicalRequest = [
      'POST',
      '/prod/items',
      'limit=2',
      canonicalHeaders,
      '',
      signedHeaderNames.join(';'),
      payloadHash,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      `${dateStamp}/us-east-1/execute-api/aws4_request`,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');
    const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${'wJalrXUtnFEMI/K7MDENG+bPxRfiCYREALKEY'}`, dateStamp), 'us-east-1'), 'execute-api'), 'aws4_request');
    const expectedSignature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
    expect(authorization).toContain(`Signature=${expectedSignature}`);

    // The real secret never travels; audit records the scheme only.
    expect(JSON.stringify(upstreamHeaders) + upstreamBody).not.toContain('wJalrXUtnFEMI/K7MDENG+bPxRfiCYREALKEY');
    expect(activities.find((a) => a.decision === 'allow')).toMatchObject({ signedWith: 'aws-sigv4' });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });
});
