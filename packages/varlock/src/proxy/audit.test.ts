import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';

import http from 'node:http';
import { URL } from 'node:url';

import {
  createProxyAuditLog,
  getProxyAuditFilePath,
  hashRequest,
  readProxyAuditLines,
  type ProxyActivity,
  type ProxyAuditEntry,
} from './audit';
import { startLocalProxyRuntime } from './runtime-proxy';

// Redirect the audit dir into a throwaway XDG_CONFIG_HOME so we never touch the
// real user config dir. The path resolves lazily, so this takes effect.
let tmpDir: string;
let prevXdg: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(os.tmpdir(), 'varlock-audit-test-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await rm(tmpDir, { recursive: true, force: true });
});

const REAL_SECRET = 'sk-stub-REALSECRETVALUE';
const PLACEHOLDER = 'sk-stub-PLACEHOLDER';

function allowActivity(overrides: Partial<ProxyActivity> = {}): ProxyActivity {
  return {
    host: 'api.example.com',
    method: 'POST',
    path: '/v1/charges',
    url: '/v1/charges?expand=true',
    matched: true,
    blocked: false,
    decision: 'allow',
    injectedKeys: ['API_KEY'],
    ruleId: 'api.example.com POST /v1/**',
    ...overrides,
  };
}

describe('proxy audit log', () => {
  test('writes a session-start header then one entry per recorded request', async () => {
    const uuid = 'header-and-entries';
    const log = createProxyAuditLog(uuid, {
      ts: '2026-06-12T00:00:00.000Z',
      id: 'ab123',
      uuid,
      cwd: '/tmp/project',
      egressMode: 'strict',
      command: ['claude'],
    });
    log.record(allowActivity());
    log.record(allowActivity({ decision: 'deny', blocked: true, injectedKeys: undefined }));
    await log.flush();

    const lines = await readProxyAuditLines(uuid);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      type: 'session-start', id: 'ab123', egressMode: 'strict', command: ['claude'],
    });
    expect(lines[1]).toMatchObject({
      type: 'request', decision: 'allow', injected: true, injectedKeys: ['API_KEY'],
    });
    expect(lines[2]).toMatchObject({ type: 'request', decision: 'deny', injected: false });
    expect((lines[2] as ProxyAuditEntry).injectedKeys).toBeUndefined();
  });

  test('never persists a secret value, even when injectedKeys are present', async () => {
    const uuid = 'no-secrets';
    const log = createProxyAuditLog(uuid);
    // A real secret would only ever be in the wire request, never in the activity
    // we record — but assert the on-disk bytes contain neither the real value nor
    // even the placeholder path/query beyond what we explicitly logged.
    log.record(allowActivity({
      path: `/v1/${PLACEHOLDER}`,
      url: `/v1/${PLACEHOLDER}?token=${PLACEHOLDER}`,
    }));
    await log.flush();

    const raw = await readFile(getProxyAuditFilePath(uuid), 'utf8');
    expect(raw).not.toContain(REAL_SECRET);
    // The entry records the key name, not a value.
    expect(raw).toContain('API_KEY');
    // Path is recorded readably (placeholders are safe); the query is only folded
    // into the fingerprint hash, never stored verbatim.
    const entry = (await readProxyAuditLines(uuid))[0] as ProxyAuditEntry;
    expect(entry.path).toBe(`/v1/${PLACEHOLDER}`);
    expect(entry.requestHash).toBe(hashRequest('POST', 'api.example.com', `/v1/${PLACEHOLDER}?token=${PLACEHOLDER}`));
    expect(JSON.stringify(entry)).not.toContain('token=');
  });

  test('appends across multiple log instances for the same session (append-only)', async () => {
    const uuid = 'append-only';
    const first = createProxyAuditLog(uuid);
    first.record(allowActivity());
    await first.flush();

    const second = createProxyAuditLog(uuid);
    second.record(allowActivity({ method: 'GET', path: '/v1/list' }));
    await second.flush();

    const entries = (await readProxyAuditLines(uuid)).filter((l): l is ProxyAuditEntry => l.type === 'request');
    expect(entries.map((e) => e.method)).toEqual(['POST', 'GET']);
  });

  test('hashRequest is deterministic and order-sensitive', () => {
    const a = hashRequest('GET', 'api.example.com', '/x');
    expect(hashRequest('GET', 'api.example.com', '/x')).toBe(a);
    expect(hashRequest('POST', 'api.example.com', '/x')).not.toBe(a);
  });

  test('readProxyAuditLines returns empty for an unknown session', async () => {
    expect(await readProxyAuditLines('does-not-exist')).toEqual([]);
  });

  test('record never throws even if the write fails (fail-safe)', async () => {
    // Point XDG at a path that can't be created (a file, not a dir) so mkdir fails.
    process.env.XDG_CONFIG_HOME = join(tmpDir, 'not-a-dir', '\0invalid');
    const log = createProxyAuditLog('fail-safe');
    expect(() => log.record(allowActivity())).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
  });

  // End-to-end seam: a real proxy runtime's onActivity, wired to a real audit
  // log (exactly as the proxy command composes them), persists a request entry.
  test('runtime activity flows through onActivity into an on-disk audit entry', async () => {
    const upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test upstream');

    const uuid = 'runtime-seam';
    const log = createProxyAuditLog(uuid, {
      ts: '2026-06-12T00:00:00.000Z', id: 'seam1', uuid, cwd: '/tmp', egressMode: 'permissive',
    });
    const runtime = await startLocalProxyRuntime({
      managedItems: [],
      rules: [{ domain: ['127.0.0.1'], itemKeys: [] }],
      egressMode: 'permissive',
      onActivity: (activity) => log.record(activity),
    });

    const proxy = new URL(runtime.env.HTTP_PROXY!);
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: `http://127.0.0.1:${addr.port}/audited/path`,
      }, (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end();
    });

    await runtime.stop();
    await log.flush();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });

    const lines = await readProxyAuditLines(uuid);
    expect(lines[0]).toMatchObject({ type: 'session-start', id: 'seam1' });
    const entry = lines.find((l): l is ProxyAuditEntry => l.type === 'request');
    expect(entry).toMatchObject({
      decision: 'allow', host: '127.0.0.1', method: 'GET', path: '/audited/path',
    });
  });
});
