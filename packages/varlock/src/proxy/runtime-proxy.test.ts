import { describe, expect, test } from 'vitest';
import http from 'node:http';
import { URL } from 'node:url';

import { startLocalProxyRuntime } from './runtime-proxy';

async function requestViaProxy(proxyUrl: string, targetUrl: string) {
  const proxy = new URL(proxyUrl);
  return await new Promise<{
    statusCode: number;
    body: string;
    headers: http.IncomingHttpHeaders;
  }>((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'GET',
      path: targetUrl,
    }, (res) => {
      const chunks: Array<Buffer> = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startLocalProxyRuntime', () => {
  test('returns proxy env vars and can be stopped', async () => {
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [],
      egressMode: 'permissive',
    });

    expect(runtime.env.HTTP_PROXY).toBeDefined();
    expect(runtime.env.HTTPS_PROXY).toBe(runtime.env.HTTP_PROXY);
    expect(runtime.env.ALL_PROXY).toBe(runtime.env.HTTP_PROXY);
    expect(runtime.env.http_proxy).toBe(runtime.env.HTTP_PROXY);
    expect(runtime.env.https_proxy).toBe(runtime.env.HTTP_PROXY);
    expect(runtime.env.all_proxy).toBe(runtime.env.HTTP_PROXY);

    expect(runtime.env.NODE_EXTRA_CA_CERTS).toBeDefined();
    expect(runtime.env.SSL_CERT_FILE).toBeDefined();
    expect(runtime.env.REQUESTS_CA_BUNDLE).toBeDefined();
    expect(runtime.env.CURL_CA_BUNDLE).toBeDefined();
    expect(runtime.env.GIT_SSL_CAINFO).toBeDefined();

    await runtime.stop();
  });

  test('blocks non-proxy domains in strict egress mode', async () => {
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [],
      egressMode: 'strict',
    });
    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://example.com/');
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('strict mode');
    await runtime.stop();
  });

  test('redacts matched response headers and body', async () => {
    const secret = 'real-secret-value';
    const placeholder = 'placeholder-value';
    const upstream = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-upstream-secret', `token=${secret}`);
      res.end(JSON.stringify({
        ok: true,
        apiKey: secret,
      }));
    });

    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const runtime = await startLocalProxyRuntime({
      managedItems: [
        {
          key: 'API_KEY',
          placeholder,
          realValue: secret,
        },
      ],
      rules: [
        {
          source: 'attached',
          domain: ['127.0.0.1'],
          itemKeys: ['API_KEY'],
        },
      ],
      egressMode: 'permissive',
    });

    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/`);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(placeholder);
    expect(response.body).not.toContain(secret);
    expect(String(response.headers['x-upstream-secret'])).toContain(placeholder);
    expect(String(response.headers['x-upstream-secret'])).not.toContain(secret);

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => {
        resolve();
      });
    });
  });
});
