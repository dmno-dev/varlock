import { describe, expect, test } from 'vitest';
import http from 'node:http';
import { URL } from 'node:url';

import { startLocalProxyRuntime } from './runtime-proxy';

async function requestViaProxy(proxyUrl: string, targetUrl: string) {
  const proxy = new URL(proxyUrl);
  return await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
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
});
