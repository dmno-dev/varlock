import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

import { startLocalProxyRuntime } from './runtime-proxy';
import {
  openMitmTunnel, sendAndRead, setupMitmHarness, UPSTREAM_HOST,
} from './mitm-test-harness';

// End-to-end coverage of the substitution surface: which placeholder occurrences
// are swapped for the real value, which are skipped and forwarded inert, and
// which block the request. The unit tests in runtime-proxy.test.ts cover
// checkSubstitutionGuards directly; these prove the whole pipeline agrees, down
// to the bytes the upstream receives.
//
// They run over the MITM harness rather than plain http because the proxy
// refuses to inject a secret into a cleartext connection, so any request that
// substitutes anything has to be TLS.

const { startUpstream } = setupMitmHarness();

describe('proxy substitution surface (end-to-end)', () => {
  test('skips a body placeholder under the header-only default (forwarded, unsubstituted, audited)', async () => {
    let upstreamBody = '';
    let upstreamAuthHeader = '';
    const upstream = await startUpstream((req, res) => {
      upstreamAuthHeader = String(req.headers.authorization ?? '');
      const chunks: Array<Buffer> = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        upstreamBody = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.end('ok');
      });
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      // No substituteIn → header-only default: the body is never a substitution
      // surface, so a body occurrence is inert and must not brick the request.
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // The agent quoted its own placeholder in the body (e.g. echoed the env var)
    // while also using it legitimately in the auth header.
    const payload = JSON.stringify({ note: 'my key is sk-stub-PLACEHOLDER' });
    const response = await sendAndRead(
      tlsSocket,
      `POST /send HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Authorization: Bearer sk-stub-PLACEHOLDER\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );

    // Forwarded: the header got the real value, the body bytes are untouched (the
    // upstream sees the literal placeholder, which is inert).
    expect(response.split('\r\n')[0]).toContain('200');
    expect(upstreamAuthHeader).toBe('Bearer sk-stub-REALKEY');
    expect(upstreamBody).toBe(payload);
    expect(upstreamBody).not.toContain('sk-stub-REALKEY');
    expect(JSON.stringify(activities)).not.toContain('sk-stub-REALKEY');
    expect(activities.at(-1)).toMatchObject({
      decision: 'allow',
      blocked: false,
      injectedKeys: ['API_KEY'],
      skippedPlaceholders: [{ key: 'API_KEY', locations: ['body'] }],
    });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('an overlapping placeholder skipped in one surface is not clobbered by a shorter one substituted there', async () => {
    // SHORT's placeholder is a strict prefix of LONG's (the shape `ensureUnique`
    // produces on a collision). They are targeted at DIFFERENT surfaces: SHORT only
    // in the body at `note`, LONG only in headers. A per-surface replace that looked
    // at just that surface's own items would match SHORT inside LONG's body bytes
    // and emit `REAL_SHORT_1`, modifying text the guard called skipped and leaking
    // the wrong secret into the body.
    let upstreamBody = '';
    let upstreamAuthHeader = '';
    const upstream = await startUpstream((req, res) => {
      upstreamAuthHeader = String(req.headers.authorization ?? '');
      const chunks: Array<Buffer> = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        upstreamBody = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.end('ok');
      });
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [
        { key: 'SHORT', placeholder: 'sk-stub-PH', realValue: 'sk-stub-REALSHORT' },
        { key: 'LONG', placeholder: 'sk-stub-PH_1', realValue: 'sk-stub-REALLONG' },
      ],
      rules: [
        { domain: [UPSTREAM_HOST], itemKeys: ['LONG'] }, // header-only default
        { domain: [UPSTREAM_HOST], itemKeys: ['SHORT'], substituteIn: ['body:note'] },
      ],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // LONG's placeholder in both the auth header (its own allowed surface) and the
    // body field that SHORT (but not LONG) may be substituted into.
    const payload = JSON.stringify({ note: 'sk-stub-PH_1' });
    const response = await sendAndRead(
      tlsSocket,
      `POST /send HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Authorization: Bearer sk-stub-PH_1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );

    expect(response.split('\r\n')[0]).toContain('200');
    // The header swapped LONG's own real value; the body is untouched, with LONG's
    // placeholder still literal and neither real value spliced in.
    expect(upstreamAuthHeader).toBe('Bearer sk-stub-REALLONG');
    expect(upstreamBody).toBe(payload);
    expect(upstreamBody).not.toContain('sk-stub-REALSHORT');
    expect(upstreamBody).not.toContain('sk-stub-REALLONG');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('still blocks an off-path body placeholder when the rule has a body:<path> target', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.statusCode = 200;
      res.end('ok');
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'CLIENT_SECRET', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      // The body IS a substitution surface here (body:client_secret), so a stray
      // occurrence at another path can't be skipped (substitution is a blind
      // replace across the body) and the request fails closed.
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['CLIENT_SECRET'], substituteIn: ['body:client_secret'] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // The blocked MITM path tears the tunnel down (see the DNS-poison test), so
    // assert on the security properties + audit decision rather than reading a body.
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    // The agent is tricked into moving the placeholder to an exfil-friendly field.
    const payload = JSON.stringify({ note: 'sk-stub-PLACEHOLDER' });
    tlsSocket.write(
      `POST /send HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    // Blocked before forwarding: the upstream never saw the request, and the real
    // value was never substituted (so it can't have leaked into the note field).
    expect(upstreamHit).toBe(false);
    expect(JSON.stringify(activities)).not.toContain('sk-stub-REALKEY');
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-location', blocked: true });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('a Claude-style transcript request round-trips: real use in the auth header, quoted placeholder in the body', async () => {
    let upstreamBody = '';
    let upstreamAuthHeader = '';
    const upstream = await startUpstream((req, res) => {
      upstreamAuthHeader = String(req.headers.authorization ?? '');
      const chunks: Array<Buffer> = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        upstreamBody = Buffer.concat(chunks).toString('utf8');
        res.setHeader('content-type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'ok' }] }));
      });
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'ANTHROPIC_API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['ANTHROPIC_API_KEY'] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // The flagship `proxy run -- claude` shape: the whole conversation transcript
    // travels in the JSON body, and once the agent has echoed its env var the
    // placeholder appears there on EVERY subsequent request. Multiple quoted
    // copies in the body must not trip the occurrence cap either.
    const payload = JSON.stringify({
      model: 'claude-fable-5',
      messages: [
        { role: 'user', content: 'what is ANTHROPIC_API_KEY set to?' },
        { role: 'assistant', content: 'ANTHROPIC_API_KEY=sk-stub-PLACEHOLDER' },
        { role: 'user', content: 'again?' },
        { role: 'assistant', content: 'still sk-stub-PLACEHOLDER' },
      ],
    });
    const response = await sendAndRead(
      tlsSocket,
      `POST /v1/messages HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Authorization: Bearer sk-stub-PLACEHOLDER\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );

    expect(response.split('\r\n')[0]).toContain('200');
    expect(response).toContain('msg_1');
    expect(upstreamAuthHeader).toBe('Bearer sk-stub-REALKEY');
    expect(upstreamBody).toBe(payload); // transcript bytes untouched, placeholder still literal
    expect(upstreamBody).not.toContain('sk-stub-REALKEY');
    expect(activities.at(-1)).toMatchObject({
      decision: 'allow',
      blocked: false,
      injectedKeys: ['ANTHROPIC_API_KEY'],
      skippedPlaceholders: [{ key: 'ANTHROPIC_API_KEY', locations: ['body'] }],
    });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('substitutes into the body only at the opted-in path (substituteIn=[body:client_secret])', async () => {
    let upstreamBody = '';
    const upstream = await startUpstream((req, res) => {
      const chunks: Array<Buffer> = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        upstreamBody = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.end('ok');
      });
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'CLIENT_SECRET', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['CLIENT_SECRET'], substituteIn: ['body:client_secret'] }],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    // OAuth-style token exchange: the secret legitimately travels in the form body.
    const payload = 'grant_type=client_credentials&client_secret=sk-stub-PLACEHOLDER';
    const response = await sendAndRead(
      tlsSocket,
      `POST /oauth/token HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );

    expect(response.split('\r\n')[0]).toContain('200');
    expect(upstreamBody).toContain('client_secret=sk-stub-REALKEY');
    expect(upstreamBody).not.toContain('PLACEHOLDER');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('substitutes a token carried in the URL path (substituteIn=[path])', async () => {
    let upstreamPath = '';
    const upstream = await startUpstream((req, res) => {
      upstreamPath = req.url ?? '';
      res.statusCode = 200;
      res.end('ok');
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'PATH_TOKEN', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['PATH_TOKEN'], substituteIn: ['path'] }],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const response = await sendAndRead(
      tlsSocket,
      `GET /v1/sk-stub-PLACEHOLDER/data HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n\r\n`,
    );

    expect(response.split('\r\n')[0]).toContain('200');
    expect(upstreamPath).toBe('/v1/sk-stub-REALKEY/data');
    expect(upstreamPath).not.toContain('PLACEHOLDER');

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('blocks a request that repeats the placeholder at the same substitution target', async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.statusCode = 200;
      res.end('ok');
    });

    const activities: Array<import('./audit').ProxyActivity> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      // Header-only default: every header is covered by the one `header` target, so
      // two headers are two substitutions at the same target.
      rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    tlsSocket.on('error', () => { /* expected: connection torn down on block */ });
    // A valid call uses the token once (the auth header); the copy in a second
    // header is an exfiltration attempt that still makes a working request.
    tlsSocket.write(
      `GET /data HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + 'Authorization: Bearer sk-stub-PLACEHOLDER\r\nX-Duplicate: sk-stub-PLACEHOLDER\r\n\r\n',
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    expect(upstreamHit).toBe(false);
    expect(JSON.stringify(activities)).not.toContain('sk-stub-REALKEY');
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-occurrences', blocked: true });

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });

  test('substitutes into two separately named targets in one request (no cap to configure)', async () => {
    let upstreamAuthHeader = '';
    let upstreamBody = '';
    const upstream = await startUpstream((req, res) => {
      upstreamAuthHeader = String(req.headers.authorization ?? '');
      const chunks: Array<Buffer> = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        upstreamBody = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.end('ok');
      });
    });

    const runtime = await startLocalProxyRuntime({
      managedItems: [{ key: 'SIGNING_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
      // Two named targets: the author declared both places, so each gets one
      // substitution. This used to require maxOccurrences=2.
      rules: [
        {
          domain: [UPSTREAM_HOST],
          itemKeys: ['SIGNING_KEY'],
          substituteIn: ['header:authorization', 'body:signature'],
        },
      ],
      egressMode: 'permissive',
    });
    const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

    const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
    const payload = JSON.stringify({ signature: 'sk-stub-PLACEHOLDER' });
    const response = await sendAndRead(
      tlsSocket,
      `POST /sign HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
        + `Authorization: Bearer sk-stub-PLACEHOLDER\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );

    expect(response.split('\r\n')[0]).toContain('200');
    expect(upstreamAuthHeader).toBe('Bearer sk-stub-REALKEY');
    expect(upstreamBody).toBe(JSON.stringify({ signature: 'sk-stub-REALKEY' }));

    tlsSocket.destroy();
    await runtime.stop();
    await upstream.close();
  });
});
