import { describe, expect, test } from 'vitest';
import http from 'node:http';
import { URL } from 'node:url';

import { startLocalProxyRuntime } from './runtime-proxy';

async function requestViaProxy(proxyUrl: string, targetUrl: string, headers?: Record<string, string>) {
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
      headers,
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

  test('only injects an item on hosts its own rule matches (per-item domain scoping)', async () => {
    // Capture exactly what the upstream receives, so we can see what the proxy
    // forwarded (the response gets re-redacted, so it can't be observed there).
    let receivedXTest = '';
    const upstream = http.createServer((req, res) => {
      receivedXTest = String(req.headers['x-test'] ?? '');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const runtime = await startLocalProxyRuntime({
      managedItems: [
        { key: 'ITEM_A', placeholder: 'PH_A_xxxxx', realValue: 'REAL_A_secret' },
        { key: 'ITEM_B', placeholder: 'PH_B_xxxxx', realValue: 'REAL_B_secret' },
      ],
      rules: [
        // ITEM_A is scoped to the request host; ITEM_B to a different host.
        { source: 'attached', domain: ['127.0.0.1'], itemKeys: ['ITEM_A'] },
        { source: 'attached', domain: ['other-host.example'], itemKeys: ['ITEM_B'] },
      ],
      egressMode: 'permissive',
    });

    await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/`, {
      'x-test': 'a=PH_A_xxxxx;b=PH_B_xxxxx',
    });

    // ITEM_A's rule matches this host → its placeholder is swapped for the real value.
    expect(receivedXTest).toContain('REAL_A_secret');
    // ITEM_B's rule is for a different host → its placeholder must pass through
    // untouched, never substituted with the real value (no cross-credential leak).
    expect(receivedXTest).toContain('PH_B_xxxxx');
    expect(receivedXTest).not.toContain('REAL_B_secret');

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('passes the client Accept-Encoding through unchanged', async () => {
    let receivedAcceptEncoding = '';
    const upstream = http.createServer((req, res) => {
      receivedAcceptEncoding = String(req.headers['accept-encoding'] ?? '');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'PH', realValue: 'secret' }],
      rules: [{ source: 'attached', domain: ['127.0.0.1'], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
    });

    await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/`, {
      'accept-encoding': 'gzip, br, deflate',
    });

    // The proxy no longer forces identity (avoids the bandwidth/compat cost for
    // a low-value protection); the client's encoding preference is preserved.
    expect(receivedAcceptEncoding).toBe('gzip, br, deflate');

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('streams text/event-stream responses through incrementally (no buffering)', async () => {
    const INTER_CHUNK_DELAY = 200;
    const upstream = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, INTER_CHUNK_DELAY);
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'PH', realValue: 'secret' }],
      rules: [{ source: 'attached', domain: ['127.0.0.1'], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
    });

    const proxy = new URL(runtime.env.HTTP_PROXY!);
    const { gapMs, body } = await new Promise<{ gapMs: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: `http://127.0.0.1:${addr.port}/`,
      }, (res) => {
        let firstAt = 0;
        let lastAt = 0;
        const chunks: Array<Buffer> = [];
        res.on('data', (chunk: Buffer) => {
          const now = Date.now();
          firstAt ||= now;
          lastAt = now;
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ gapMs: lastAt - firstAt, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });

    expect(body).toContain('data: one');
    expect(body).toContain('data: two');
    // If the proxy had buffered the whole response, both chunks would arrive
    // together at the end and the gap would be ~0. A gap near the server's
    // inter-chunk delay proves chunks were forwarded as they arrived.
    expect(gapMs).toBeGreaterThanOrEqual(INTER_CHUNK_DELAY - 80);

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });
});
