import { describe, expect, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { URL } from 'node:url';

import type { ProxyActivity } from './audit';
import {
  checkSubstitutionGuards, dataPlaneAuthOk, findUninjectedPlaceholder, parseProxyAuthToken,
  startLocalProxyRuntime, substitutePlaceholdersInSurface,
  type SubstitutionGuardRequest,
} from './runtime-proxy';
import type { RequestScopedManagedItem } from './policy';

/** Bind an ephemeral port, capture it, release it — a free port for a fixed-port test. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

describe('findUninjectedPlaceholder (helpful-failure guard)', () => {
  const items = [
    { key: 'A', placeholder: 'vlk_ph_A', realValue: 'RA' },
    { key: 'B', placeholder: 'vlk_ph_B', realValue: 'RB' },
  ] as any;

  test('flags a placeholder present in the request that is NOT injected here', () => {
    // A is being injected on this route; B's placeholder is present but not injected.
    const found = findUninjectedPlaceholder(['authorization: Bearer vlk_ph_B'], items, [items[0]]);
    expect(found?.key).toBe('B');
  });

  test('does not flag a placeholder that WILL be injected on this route', () => {
    expect(findUninjectedPlaceholder(['Bearer vlk_ph_A'], items, [items[0]])).toBeUndefined();
  });

  test('does not flag a request with no managed placeholder (permissive passthrough stays clean)', () => {
    expect(findUninjectedPlaceholder(['authorization: Bearer sk-users-own-key'], items, [])).toBeUndefined();
  });

  test('scans all parts (target, headers, body) and ignores empty placeholders', () => {
    const withEmpty = [...items, { key: 'C', placeholder: '', realValue: 'RC' }] as any;
    expect(findUninjectedPlaceholder(['/p', '{}', 'body has vlk_ph_A'], withEmpty, [])?.key).toBe('A');
  });
});

describe('substitutePlaceholdersInSurface', () => {
  // A's placeholder is a strict prefix of B's: the shape `ensureUnique` produces
  // when two items' derived placeholders collide (it appends `_1`).
  const overlapping = [
    { key: 'A', placeholder: 'vlk_x', realValue: 'REAL_A' },
    { key: 'B', placeholder: 'vlk_x_1', realValue: 'REAL_B' },
  ] as any;
  const allKeys = new Set(['A', 'B']);

  test('substitutes the longest placeholder first so substring placeholders are not corrupted', () => {
    // Naive left-to-right replacement would splice REAL_A into B's text and never
    // match B correctly.
    const input = 'a=vlk_x&b=vlk_x_1';
    expect(substitutePlaceholdersInSurface(input, overlapping, allKeys)).toBe('a=REAL_A&b=REAL_B');
  });

  test('leaves a skipped placeholder untouched even when a substitutable one is its prefix', () => {
    // B is skipped in this surface (not in substituteKeys) while A, a prefix of B's
    // placeholder, is substitutable. Matching only A's list would rewrite B's bytes
    // into `REAL_A_1`, modifying supposedly inert text AND emitting the wrong secret.
    const input = 'note=vlk_x_1';
    expect(substitutePlaceholdersInSurface(input, overlapping, new Set(['A']))).toBe('note=vlk_x_1');
  });

  test('still substitutes the shorter placeholder where it stands on its own', () => {
    const input = 'auth=vlk_x&note=vlk_x_1';
    expect(substitutePlaceholdersInSurface(input, overlapping, new Set(['A']))).toBe('auth=REAL_A&note=vlk_x_1');
  });

  test('substitutes nothing when the surface allows no items', () => {
    expect(substitutePlaceholdersInSurface('a=vlk_x&b=vlk_x_1', overlapping, new Set())).toBe('a=vlk_x&b=vlk_x_1');
  });

  test('never rescans a substituted value, so a real value containing a placeholder is left alone', () => {
    const items = [
      { key: 'A', placeholder: 'PH_A', realValue: 'real-with-PH_B-inside' },
      { key: 'B', placeholder: 'PH_B', realValue: 'REAL_B' },
    ] as any;
    expect(substitutePlaceholdersInSurface('x=PH_A', items, new Set(['A', 'B']))).toBe('x=real-with-PH_B-inside');
  });

  test('ignores empty placeholders and returns the input unchanged when there are none', () => {
    expect(substitutePlaceholdersInSurface('anything', [{ key: 'C', placeholder: '', realValue: 'RC' }] as any, new Set(['C'])))
      .toBe('anything');
  });
});

describe('checkSubstitutionGuards', () => {
  const emptyReq: SubstitutionGuardRequest = {
    headers: [], requestTarget: '/', body: '', contentType: undefined,
  };
  const item = (over: Partial<RequestScopedManagedItem> = {}): RequestScopedManagedItem => ({
    key: 'API_KEY',
    placeholder: 'vlk_ph_key',
    realValue: 'sk-real',
    targets: [{ location: 'header' }],
    ...over,
  });
  const jsonBody = (obj: unknown): Partial<SubstitutionGuardRequest> => ({
    body: JSON.stringify(obj), contentType: 'application/json',
  });

  const ok = { violation: undefined };

  test('allows a placeholder in an allowed header within the occurrence cap', () => {
    const req = { ...emptyReq, headers: [{ name: 'authorization', value: 'Bearer vlk_ph_key' }] };
    expect(checkSubstitutionGuards(req, [item()])).toMatchObject({ ...ok, injectedKeys: ['API_KEY'], skipped: [] });
  });

  test('skips (does not substitute) a body placeholder under the any-header default', () => {
    // The agent quoted its own placeholder in the body (e.g. a conversation
    // transcript echoing the env var). The body is never a substitution surface for
    // this item, so the occurrence is inert: forward it, report it as skipped.
    const req = { ...emptyReq, ...jsonBody({ note: 'vlk_ph_key' }) };
    const result = checkSubstitutionGuards(req, [item()]);
    expect(result.violation).toBeUndefined();
    expect(result.injectedKeys).toEqual([]); // nothing at an allowed target, so nothing injected
    expect(result.skipped).toMatchObject([{ item: { key: 'API_KEY' }, locations: ['body'] }]);
  });

  test('a header use plus skipped body occurrences: forwarded, body spends no target budget', () => {
    const req = {
      ...emptyReq,
      headers: [{ name: 'authorization', value: 'Bearer vlk_ph_key' }],
      ...jsonBody({ note: 'vlk_ph_key', quoted: 'echo vlk_ph_key' }),
    };
    // Header-only default: the two body copies belong to no target, so the single
    // `header` substitution is still within budget.
    const result = checkSubstitutionGuards(req, [item()]);
    expect(result.violation).toBeUndefined();
    expect(result.injectedKeys).toEqual(['API_KEY']);
    expect(result.skipped).toMatchObject([{ item: { key: 'API_KEY' }, locations: ['body'] }]);
  });

  test('allows a body placeholder only at the exact path it was widened to', () => {
    const req = { ...emptyReq, ...jsonBody({ client_secret: 'vlk_ph_key' }) };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: 'client_secret' }] })]))
      .toMatchObject({ ...ok, injectedKeys: ['API_KEY'] });
  });

  test('blocks a body placeholder at a DIFFERENT path than the one allowed (the exfil case)', () => {
    // body:client_secret is allowed, but the agent put the placeholder in `note`
    // instead. Since the body IS a substitution surface for this item, the blind
    // body replace can't skip the stray occurrence: fail closed, no skipping.
    const req = { ...emptyReq, ...jsonBody({ note: 'vlk_ph_key' }) };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: 'client_secret' }] })]))
      .toMatchObject({ violation: { kind: 'location', location: 'body' } });
  });

  test('the any-header default skips denylisted forward/log headers (cookie, x-forwarded-*, ...)', () => {
    // Placeholder redirected into a header the upstream might forward/log: not
    // substituted there (so it stays inert), and reported as skipped.
    for (const name of ['cookie', 'x-forwarded-for', 'host', 'referer', 'user-agent']) {
      const req = { ...emptyReq, headers: [{ name, value: 'x vlk_ph_key y' }] };
      expect(checkSubstitutionGuards(req, [item()]))
        .toMatchObject({ ...ok, injectedKeys: [], skipped: [{ locations: [`header:${name}`] }] });
    }
  });

  test('an explicit header:<name> target overrides the denylist', () => {
    const req = { ...emptyReq, headers: [{ name: 'cookie', value: 'session=vlk_ph_key' }] };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'header', name: 'cookie' }] })]))
      .toMatchObject({ ...ok, injectedKeys: ['API_KEY'], skipped: [] });
  });

  test('pins to a specific header name; other headers are skipped', () => {
    const allowed = item({ targets: [{ location: 'header', name: 'authorization' }] });
    const inAuth = { ...emptyReq, headers: [{ name: 'authorization', value: 'Bearer vlk_ph_key' }] };
    expect(checkSubstitutionGuards(inAuth, [allowed])).toMatchObject({ ...ok, injectedKeys: ['API_KEY'] });
    const inOther = { ...emptyReq, headers: [{ name: 'x-evil', value: 'vlk_ph_key' }] };
    expect(checkSubstitutionGuards(inOther, [allowed]))
      .toMatchObject({ ...ok, injectedKeys: [], skipped: [{ locations: ['header:x-evil'] }] });
  });

  test('skips a URL-path placeholder by default, substitutes it with substituteIn=[path]', () => {
    const req = { ...emptyReq, requestTarget: '/v1/vlk_ph_key/data' };
    expect(checkSubstitutionGuards(req, [item()]))
      .toMatchObject({ ...ok, injectedKeys: [], skipped: [{ locations: ['path'] }] });
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'path' }] })]))
      .toMatchObject({ ...ok, injectedKeys: ['API_KEY'], skipped: [] });
  });

  test('path and query are distinct: a path token is not covered by bare query (and vice versa)', () => {
    const inPath = { ...emptyReq, requestTarget: '/v1/vlk_ph_key/data?page=2' };
    expect(checkSubstitutionGuards(inPath, [item({ targets: [{ location: 'query' }] })]))
      .toMatchObject({ ...ok, injectedKeys: [], skipped: [{ locations: ['path'] }] });
    const inQuery = { ...emptyReq, requestTarget: '/v1/data?token=vlk_ph_key' };
    expect(checkSubstitutionGuards(inQuery, [item({ targets: [{ location: 'path' }] })]))
      .toMatchObject({ ...ok, injectedKeys: [], skipped: [{ locations: ['query'] }] });
    // ...and bare query does cover the query string
    expect(checkSubstitutionGuards(inQuery, [item({ targets: [{ location: 'query' }] })]))
      .toMatchObject({ ...ok, injectedKeys: ['API_KEY'], skipped: [] });
  });

  test('allows a placeholder in a named query param, blocks it in a different param', () => {
    const req = { ...emptyReq, requestTarget: '/v1?api_key=vlk_ph_key' };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'query', name: 'api_key' }] })]))
      .toMatchObject({ ...ok, injectedKeys: ['API_KEY'] });
    // The query IS a substitution surface for this item (query:api_key), so a stray
    // occurrence in another param fails closed: the query is substituted as one
    // string and can't skip it.
    const other = { ...emptyReq, requestTarget: '/v1?leak=vlk_ph_key' };
    expect(checkSubstitutionGuards(other, [item({ targets: [{ location: 'query', name: 'api_key' }] })]))
      .toMatchObject({ violation: { kind: 'location', location: 'query' } });
  });

  test('blocks two occurrences that land on the SAME target (bare header covers both)', () => {
    // Legit auth header + attacker copy in another header: both are covered by the
    // one `header` target, so both would be substituted and which copy is the real
    // use is ambiguous. Fail closed.
    const req = {
      ...emptyReq,
      headers: [
        { name: 'authorization', value: 'Bearer vlk_ph_key' },
        { name: 'x-duplicate', value: 'vlk_ph_key' },
      ],
    };
    expect(checkSubstitutionGuards(req, [item()]))
      .toMatchObject({ violation: { kind: 'occurrences', target: 'header', count: 2 } });
  });

  test('blocks two occurrences in the same header value', () => {
    const req = { ...emptyReq, headers: [{ name: 'authorization', value: 'Bearer vlk_ph_key vlk_ph_key' }] };
    expect(checkSubstitutionGuards(req, [item()]))
      .toMatchObject({ violation: { kind: 'occurrences', target: 'header', count: 2 } });
  });

  test('allows one occurrence per DISTINCT target with no extra configuration', () => {
    // The author declared both places legitimate, so each gets its own substitution.
    // This is the case that used to need maxOccurrences=2.
    const req = {
      ...emptyReq,
      headers: [{ name: 'authorization', value: 'Bearer vlk_ph_key' }],
      ...jsonBody({ signature: 'vlk_ph_key' }),
    };
    const allowed = item({
      targets: [{ location: 'header', name: 'authorization' }, { location: 'body', path: 'signature' }],
    });
    expect(checkSubstitutionGuards(req, [allowed])).toMatchObject({ ...ok, injectedKeys: ['API_KEY'] });
  });

  test('allows the same secret in two separately named headers', () => {
    const req = {
      ...emptyReq,
      headers: [
        { name: 'authorization', value: 'Bearer vlk_ph_key' },
        { name: 'x-api-key', value: 'vlk_ph_key' },
      ],
    };
    const allowed = item({
      targets: [{ location: 'header', name: 'authorization' }, { location: 'header', name: 'x-api-key' }],
    });
    expect(checkSubstitutionGuards(req, [allowed])).toMatchObject({ ...ok, injectedKeys: ['API_KEY'] });
  });

  test('the broadest allowing target wins, so declaring header AND header:<name> grants no extra budget', () => {
    // Without this, an occurrence in `authorization` could bill to `header:authorization`
    // while a second in `x-evil` billed to `header`, letting two copies through.
    const req = {
      ...emptyReq,
      headers: [
        { name: 'authorization', value: 'Bearer vlk_ph_key' },
        { name: 'x-evil', value: 'vlk_ph_key' },
      ],
    };
    const allowed = item({ targets: [{ location: 'header' }, { location: 'header', name: 'authorization' }] });
    expect(checkSubstitutionGuards(req, [allowed]))
      .toMatchObject({ violation: { kind: 'occurrences', target: 'header', count: 2 } });
  });

  test('fails closed when a body:path target is set but the body cannot be parsed', () => {
    const req = { ...emptyReq, body: 'vlk_ph_key not-json', contentType: 'application/json' };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: 'client_secret' }] })]))
      .toMatchObject({ violation: { kind: 'location', location: 'body' } });
  });

  test('body:* allows the placeholder anywhere in an unparseable (e.g. XML) body', () => {
    const xml = '<soap:Envelope><auth><token>vlk_ph_key</token></auth></soap:Envelope>';
    const req = { ...emptyReq, body: xml, contentType: 'application/xml' };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: '*' }] })]))
      .toMatchObject({ ...ok, injectedKeys: ['API_KEY'] });
  });

  test('body:* still respects the occurrence cap', () => {
    // Two copies in an unstructured body — anywhere is allowed, but the default cap is 1.
    const req = { ...emptyReq, body: 'sig=vlk_ph_key&dup=vlk_ph_key', contentType: 'text/plain' };
    expect(checkSubstitutionGuards(req, [item({ targets: [{ location: 'body', path: '*' }] })]))
      .toMatchObject({ violation: { kind: 'occurrences', count: 2 } });
  });

  test('ignores items with an empty placeholder', () => {
    const req = { ...emptyReq, body: 'anything' };
    expect(checkSubstitutionGuards(req, [item({ placeholder: '' })]))
      .toMatchObject({ ...ok, injectedKeys: [], skipped: [] });
  });
});

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

function basicAuthHeader(user: string, token: string): string {
  return `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

describe('parseProxyAuthToken', () => {
  test('extracts the password half of a Basic credential', () => {
    expect(parseProxyAuthToken(basicAuthHeader('varlock', 'tok-abc'))).toBe('tok-abc');
  });

  test('ignores the (cosmetic) username', () => {
    expect(parseProxyAuthToken(basicAuthHeader('anything', 'tok-xyz'))).toBe('tok-xyz');
  });

  test('returns undefined for a non-Basic scheme, missing header, or garbage', () => {
    expect(parseProxyAuthToken('Bearer tok')).toBeUndefined();
    expect(parseProxyAuthToken(undefined)).toBeUndefined();
    expect(parseProxyAuthToken('Basic')).toBeUndefined();
  });
});

describe('dataPlaneAuthOk', () => {
  const token = 'session-token-123';

  test('loopback peers are exempt regardless of header/token', () => {
    expect(dataPlaneAuthOk('127.0.0.1', undefined, token)).toBe(true);
    expect(dataPlaneAuthOk('::1', undefined, undefined)).toBe(true);
    expect(dataPlaneAuthOk('::ffff:127.0.0.1', 'garbage', token)).toBe(true);
  });

  test('a non-loopback peer with the correct token passes', () => {
    expect(dataPlaneAuthOk('10.0.0.9', basicAuthHeader('varlock', token), token)).toBe(true);
  });

  test('a non-loopback peer with a wrong or missing token is rejected', () => {
    expect(dataPlaneAuthOk('10.0.0.9', basicAuthHeader('varlock', 'wrong'), token)).toBe(false);
    expect(dataPlaneAuthOk('10.0.0.9', undefined, token)).toBe(false);
  });

  test('a non-loopback peer fails closed when no token is configured', () => {
    expect(dataPlaneAuthOk('10.0.0.9', basicAuthHeader('varlock', 'anything'), undefined)).toBe(false);
  });
});

describe('startLocalProxyRuntime', () => {
  test('refuses a non-loopback bind without a data-plane token', async () => {
    await expect(startLocalProxyRuntime({
      managedItems: [], rules: [], egressMode: 'permissive', listenHost: '0.0.0.0',
    })).rejects.toThrow(/serving the tunnel off-loopback requires a data-plane token/);
  });

  test('accepts a non-loopback bind when a token is supplied, and can be stopped', async () => {
    const runtime = await startLocalProxyRuntime({
      managedItems: [], rules: [], egressMode: 'permissive', listenHost: '127.0.0.1', dataPlaneToken: 'tok',
    });
    // A loopback client (the test) is exempt, so proxying still works with a token set.
    expect(runtime.env.HTTP_PROXY).toBeDefined();
    await runtime.stop();
  });

  test('--persist-ca reuses the CA across restarts, and keeps it (0600) after stop', async () => {
    // A broker restart (including a sandbox waking from hibernation) must not
    // invalidate agents that already trust this CA.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'varlock-persist-ca-'));
    try {
      const first = await startLocalProxyRuntime({
        managedItems: [], rules: [], egressMode: 'permissive', certDir: dir, persistCa: true,
      });
      const firstCert = readFileSync(path.join(dir, 'ca-cert.pem'), 'utf8');
      await first.stop();

      // survives stop, unlike the non-persisted case
      const keyPath = path.join(dir, 'ca-key.pem');
      expect(existsSync(keyPath)).toBe(true);
      expect(existsSync(path.join(dir, 'ca-cert.pem'))).toBe(true);
      // eslint-disable-next-line no-bitwise -- mode bits
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);

      const second = await startLocalProxyRuntime({
        managedItems: [], rules: [], egressMode: 'permissive', certDir: dir, persistCa: true,
      });
      expect(readFileSync(path.join(dir, 'ca-cert.pem'), 'utf8')).toBe(firstCert);
      await second.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without --persist-ca each start mints a fresh CA and cleans up', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'varlock-ephemeral-ca-'));
    try {
      const first = await startLocalProxyRuntime({
        managedItems: [], rules: [], egressMode: 'permissive', certDir: dir,
      });
      const firstCert = readFileSync(path.join(dir, 'ca-cert.pem'), 'utf8');
      await first.stop();
      expect(existsSync(path.join(dir, 'ca-cert.pem'))).toBe(false);
      expect(existsSync(path.join(dir, 'ca-key.pem'))).toBe(false);

      const second = await startLocalProxyRuntime({
        managedItems: [], rules: [], egressMode: 'permissive', certDir: dir,
      });
      expect(readFileSync(path.join(dir, 'ca-cert.pem'), 'utf8')).not.toBe(firstCert);
      await second.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    expect(runtime.env.DENO_CERT).toBe(runtime.env.SSL_CERT_FILE);
    // without this, node's built-in fetch silently bypasses the proxy (node >= 24)
    expect(runtime.env.NODE_USE_ENV_PROXY).toBe('1');

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
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
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
      rules: [{ domain: ['127.0.0.1'], itemKeys: ['API_KEY'] }],
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
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
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

  test('strips Proxy-Authorization instead of forwarding it upstream (hop-by-hop)', async () => {
    // A client with credentials in its proxy url (userinfo) sends
    // Proxy-Authorization addressed to the proxy; the upstream must not see it.
    let upstreamSawProxyAuth: string | undefined;
    const upstream = http.createServer((req, res) => {
      upstreamSawProxyAuth = req.headers['proxy-authorization'] as string | undefined;
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
      egressMode: 'permissive',
    });

    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, `http://127.0.0.1:${addr.port}/`, {
      'proxy-authorization': 'Basic c29tZXRva2VuOg==',
    });

    expect(res.statusCode).toBe(200);
    expect(upstreamSawProxyAuth).toBeUndefined();

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
          domain: ['127.0.0.1'], itemKeys: [], block: true,
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
      rules: [{ domain: ['127.0.0.1'], itemKeys: ['API_KEY'] }],
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
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
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
          domain: ['127.0.0.1'], itemKeys: [], approval: {},
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
          domain: ['127.0.0.1'], itemKeys: [], approval: {},
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

  test('approval downgrade closed: an approval-gated key is not injected on a plain-allow-exempted path', async () => {
    let upstreamHit = false;
    let approvalCalls = 0;
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
      managedItems: [{ key: 'SECRET', placeholder: 'PH_SECRET', realValue: 'REAL_SECRET_VALUE' }],
      rules: [
        // Broad rule carrying SECRET, gated behind approval.
        { domain: ['127.0.0.1'], itemKeys: ['SECRET'], approval: {} },
        // More-specific plain-allow rule exempting /health — this decides the
        // verdict (specificity), so the approval gate is skipped on /health.
        { domain: ['127.0.0.1'], path: '/health', itemKeys: [] },
      ],
      egressMode: 'permissive',
      onActivity: (a) => activities.push(a),
      // Would approve if ever asked — proving the point that it is NOT asked, and
      // the secret is still withheld rather than smuggled in without a prompt.
      approvalProvider: {
        async requestApproval(r) {
          approvalCalls += 1;
          return { approved: true, nonce: r.nonce };
        },
      },
    });

    const response = await requestViaProxy(
      runtime.env.HTTP_PROXY!,
      `http://127.0.0.1:${addr.port}/health`,
      { authorization: 'Bearer PH_SECRET' },
    );

    // The real value never reaches (or is echoed by) the upstream, the approval
    // gate was correctly skipped (verdict = allow), and — the regression this
    // guards — SECRET was WITHHELD from injection scope, so the request is blocked
    // as uninjected rather than being injected without a prompt. Before the fix,
    // SECRET leaked into scope and the cleartext guard fired instead
    // (decision 'blocked-cleartext').
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('REAL_SECRET_VALUE');
    expect(upstreamHit).toBe(false);
    expect(approvalCalls).toBe(0);
    expect(activities.at(-1)).toMatchObject({ decision: 'blocked-uninjected', blocked: true, path: '/health' });

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
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
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

describe('varlock.internal session-env endpoint', () => {
  const TOKEN = 'test-session-token-uuid';
  const PAYLOAD_JSON = JSON.stringify({
    env: { FOO: 'bar', API_KEY: 'vlk_placeholder_API_KEY_abc' },
    omittedKeys: ['ADMIN_TOKEN'],
    serializedGraph: { settings: {}, config: {}, sources: [] },
  });

  async function startWithEndpoint(opts?: { egressMode?: 'permissive' | 'strict'; skipPayload?: boolean }) {
    const activities: Array<ProxyActivity> = [];
    const authFailures: Array<true> = [];
    const served: Array<{ passthroughCount?: number } | undefined> = [];
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [],
      egressMode: opts?.egressMode ?? 'permissive',
      internalEndpoint: {
        token: TOKEN,
        onAuthFailure: () => authFailures.push(true),
        onServed: (meta) => served.push(meta),
      },
      onActivity: (a) => activities.push(a),
    });
    if (!opts?.skipPayload) runtime.setSessionEnvPayloadJson(PAYLOAD_JSON, { passthroughCount: 2 });
    return {
      runtime, activities, authFailures, served,
    };
  }

  test('serves the current payload with a valid token, without reporting egress activity', async () => {
    const {
      runtime, activities, served, authFailures,
    } = await startWithEndpoint();
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual(JSON.parse(PAYLOAD_JSON));
    // control plane, not traffic: never counted as egress
    expect(activities).toEqual([]);
    // owner visibility: served callback fires with the payload's meta, no auth failures
    expect(served).toEqual([{ passthroughCount: 2 }]);
    expect(authFailures).toEqual([]);
    await runtime.stop();
  });

  test('serves the LATEST payload after a swap (reload freshness)', async () => {
    const { runtime } = await startWithEndpoint();
    const updated = JSON.stringify({ env: { FOO: 'post-reload' }, omittedKeys: [], serializedGraph: { config: {} } });
    runtime.setSessionEnvPayloadJson(updated);
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(JSON.parse(res.body).env.FOO).toBe('post-reload');
    await runtime.stop();
  });

  test('refuses a missing or wrong token with 403, serves nothing, and surfaces the attempt', async () => {
    const { runtime, authFailures, served } = await startWithEndpoint();
    const noToken = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
    });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.body).not.toContain('API_KEY');
    const wrongToken = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': 'wrong-token-same-length--',
    });
    expect(wrongToken.statusCode).toBe(403);
    // both attempts surfaced to the owner; nothing served
    expect(authFailures).toEqual([true, true]);
    expect(served).toEqual([]);
    await runtime.stop();
  });

  test('403s when the endpoint is not enabled, even with some token', async () => {
    const runtime = await startLocalProxyRuntime({ managedItems: [], rules: [], egressMode: 'permissive' });
    runtime.setSessionEnvPayloadJson(PAYLOAD_JSON);
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(403);
    await runtime.stop();
  });

  test('404s an unknown internal path (token first: only authenticated callers learn paths)', async () => {
    const { runtime } = await startWithEndpoint();
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/nope', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(404);
    await runtime.stop();
  });

  test('503s when the payload has not been set yet', async () => {
    const { runtime } = await startWithEndpoint({ skipPayload: true });
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(503);
    await runtime.stop();
  });

  test('reachable under strict egress (handled before the egress gate)', async () => {
    const { runtime } = await startWithEndpoint({ egressMode: 'strict' });
    const res = await requestViaProxy(runtime.env.HTTP_PROXY!, 'http://varlock.internal/session-env', {
      host: 'varlock.internal',
      'x-varlock-proxy-token': TOKEN,
    });
    expect(res.statusCode).toBe(200);
    await runtime.stop();
  });
});

describe('startLocalProxyRuntime — fixed port and cert dir', () => {
  test('binds a caller-provided port (surfaced as HTTP(S)_PROXY)', async () => {
    const port = await getFreePort();
    const runtime = await startLocalProxyRuntime({
      managedItems: [], rules: [], egressMode: 'permissive', port,
    });
    expect(runtime.env.HTTP_PROXY).toBe(`http://127.0.0.1:${port}`);
    expect(runtime.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${port}`);
    await runtime.stop();
  });

  test('a busy fixed port fails to start with a clear error', async () => {
    const port = await getFreePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(port, '127.0.0.1', () => resolve());
    });
    try {
      await expect(startLocalProxyRuntime({
        managedItems: [], rules: [], egressMode: 'permissive', port,
      })).rejects.toThrow(new RegExp(`port ${port} is already in use`));
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }
  });

  test('writes the CA cert into a caller-provided dir; stop removes only its files, not the dir', async () => {
    const certDir = mkdtempSync(path.join(os.tmpdir(), 'vlk-certdir-'));
    try {
      const runtime = await startLocalProxyRuntime({
        managedItems: [], rules: [], egressMode: 'permissive', certDir,
      });
      const caCert = path.join(certDir, 'ca-cert.pem');
      const combined = path.join(certDir, 'combined-ca.pem');
      expect(existsSync(caCert)).toBe(true);
      expect(existsSync(combined)).toBe(true);
      expect(runtime.env.NODE_EXTRA_CA_CERTS).toBe(caCert); // known CA path a caller can wire up

      await runtime.stop();
      expect(existsSync(caCert)).toBe(false); // cert files we wrote are cleaned
      expect(existsSync(combined)).toBe(false);
      expect(existsSync(certDir)).toBe(true); // but the caller's dir is left alone
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});
