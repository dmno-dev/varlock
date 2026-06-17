import { describe, expect, test } from 'vitest';
import http from 'node:http';
import { URL } from 'node:url';

import type { ProxyActivity } from './audit';
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

  test('reconfigure() hot-swaps rules/egress on a live runtime', async () => {
    const upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to start upstream');
    const target = `http://127.0.0.1:${addr.port}/`;

    // Strict + no rules → the upstream host is not allowlisted → blocked.
    const runtime = await startLocalProxyRuntime({ managedItems: [], rules: [], egressMode: 'strict' });
    expect((await requestViaProxy(runtime.env.HTTP_PROXY!, target)).statusCode).toBe(403);

    // Reconfigure to allow 127.0.0.1 → the same request now reaches the upstream.
    runtime.reconfigure({
      managedItems: [],
      rules: [{ source: 'attached', domain: ['127.0.0.1'], itemKeys: [] }],
      egressMode: 'strict',
    });
    const allowed = await requestViaProxy(runtime.env.HTTP_PROXY!, target);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toBe('ok');

    // Reconfigure back to no rules → blocked again (proves it's not one-way).
    runtime.reconfigure({ managedItems: [], rules: [], egressMode: 'strict' });
    expect((await requestViaProxy(runtime.env.HTTP_PROXY!, target)).statusCode).toBe(403);

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('refuses to inject a secret into a cleartext (http) connection (Invariant #2)', async () => {
    let upstreamGotRequest = false;
    let upstreamAuth = '';
    const upstream = http.createServer((req, res) => {
      upstreamGotRequest = true;
      upstreamAuth = String(req.headers.authorization ?? '');
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'PH_placeholder', realValue: 'sk-REAL-secret' }],
      rules: [{ source: 'attached', domain: ['127.0.0.1'], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
    });

    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/`, {
      authorization: 'Bearer PH_placeholder',
    });

    // Fail closed: a ruled item over a cleartext connection is refused, and the
    // real secret never reaches the (un-TLS'd) upstream.
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('cleartext');
    expect(upstreamGotRequest).toBe(false);
    expect(upstreamAuth).not.toContain('sk-REAL-secret');

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
      // No injected items — these tests exercise forwarding/streaming behavior,
      // not injection (which now requires TLS, see proxy-tls.test.ts).
      managedItems: [],
      rules: [{ source: 'attached', domain: ['127.0.0.1'], itemKeys: [] }],
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

  test('emits a blocked-egress activity in strict mode (no secrets in the activity)', async () => {
    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [],
      egressMode: 'strict',
      onActivity: (a) => activities.push(a),
    });

    await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://example.com/some/path');

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      decision: 'blocked-egress', host: 'example.com', method: 'GET', path: '/some/path', matched: false, blocked: true,
    });
    expect(activities[0]!.injectedKeys).toBeUndefined();

    await runtime.stop();
  });

  test('emits a deny activity (block rule) that never reaches upstream', async () => {
    let upstreamHit = false;
    const upstream = http.createServer((_req, res) => {
      upstreamHit = true;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [
        {
          source: 'attached', domain: ['127.0.0.1'], itemKeys: [], block: true,
        },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });

    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/charge`);
    expect(response.statusCode).toBe(403);
    expect(upstreamHit).toBe(false);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      decision: 'deny', host: '127.0.0.1', path: '/charge', matched: true, blocked: true,
    });
    expect(activities[0]!.ruleId).toContain('block');

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('emits a single blocked-cleartext activity (not allow-then-block) and no secret', async () => {
    const upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'PH_placeholder', realValue: 'sk-REAL-secret' }],
      rules: [{ source: 'attached', domain: ['127.0.0.1'], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });

    await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/`, {
      authorization: 'Bearer PH_placeholder',
    });

    expect(activities).toHaveLength(1);
    expect(activities[0]!.decision).toBe('blocked-cleartext');
    expect(JSON.stringify(activities)).not.toContain('sk-REAL-secret');

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('emits an allow activity for a forwarded (non-injected) request', async () => {
    const upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [{ source: 'attached', domain: ['127.0.0.1'], itemKeys: [] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });

    await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/list?page=2`);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      decision: 'allow', host: '127.0.0.1', path: '/list', matched: true, blocked: false,
    });
    // path excludes the query; the full url is carried separately for the hash
    expect(activities[0]!.path).toBe('/list');
    expect(activities[0]!.url).toBe('/list?page=2');
    expect(activities[0]!.injectedKeys).toBeUndefined();

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('require-approval: a denied request never reaches upstream (fail closed)', async () => {
    let upstreamHit = false;
    const upstream = http.createServer((_req, res) => {
      upstreamHit = true;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [
        {
          source: 'attached', domain: ['127.0.0.1'], itemKeys: [], approval: true,
        },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
      approvalProvider: { async requestApproval(r) { return { approved: false, nonce: r.nonce }; } },
    });

    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/v1/refunds`);
    expect(response.statusCode).toBe(403);
    expect(upstreamHit).toBe(false);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ decision: 'approval-denied', blocked: true, path: '/v1/refunds' });

    await runtime.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  test('require-approval: an approved request is forwarded and audited as approval-granted', async () => {
    let upstreamHit = false;
    const upstream = http.createServer((_req, res) => {
      upstreamHit = true;
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const seen: Array<{ method: string; path: string; bodyHash: string }> = [];
    const activities: Array<ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [
        {
          source: 'attached', domain: ['127.0.0.1'], itemKeys: [], approval: true,
        },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
      approvalProvider: {
        async requestApproval(r) {
          // the provider is handed the request-bound details (Invariant #8)
          seen.push({ method: r.method, path: r.path, bodyHash: r.bodyHash });
          return { approved: true, nonce: r.nonce };
        },
      },
    });

    const response = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/v1/refunds`);
    expect(response.statusCode).toBe(200);
    expect(upstreamHit).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/v1/refunds' });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.decision).toBe('approval-granted');

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
      // No injected items — these tests exercise forwarding/streaming behavior,
      // not injection (which now requires TLS, see proxy-tls.test.ts).
      managedItems: [],
      rules: [{ source: 'attached', domain: ['127.0.0.1'], itemKeys: [] }],
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
