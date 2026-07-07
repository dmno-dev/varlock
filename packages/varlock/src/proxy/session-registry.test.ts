import net from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';

import {
  createProxySessionRecord,
  deleteProxySession,
  getProxySessionByToken,
  getProxySessionDir,
  getProxySessionPort,
  isProxySessionAlive,
  listProxySessions,
  markProxySessionEnded,
  pruneEndedProxySessions,
  type ProxySessionRecord,
} from './session-registry';

// Redirect the sessions dir into a throwaway XDG_CONFIG_HOME so we never touch
// the real user config dir. Paths resolve lazily, so this takes effect.
let tmpDir: string;
let prevXdg: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(os.tmpdir(), 'varlock-session-test-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await rm(tmpDir, { recursive: true, force: true });
});

function record(overrides: Partial<ProxySessionRecord> = {}): Omit<ProxySessionRecord, 'updatedAt'> {
  return {
    id: 'abc12',
    uuid: 'uuid-1',
    // Use this test process's pid so the session counts as "running".
    ownerPid: process.pid,
    cwd: '/tmp/project',
    startedAt: '2026-06-13T00:00:00.000Z',
    egressMode: 'permissive',
    env: { FOO: 'bar' },
    ...overrides,
  };
}

describe('proxy session liveness (PID-reuse-safe)', () => {
  test('getProxySessionPort parses the loopback proxy port from the env', () => {
    expect(getProxySessionPort(record({ env: { HTTPS_PROXY: 'http://127.0.0.1:58633' } }) as ProxySessionRecord)).toBe(58633);
    expect(getProxySessionPort(record({ env: {} }) as ProxySessionRecord)).toBeUndefined();
  });

  test('a live pid whose proxy port is dead is NOT alive (the ghost / PID-reuse case)', async () => {
    // ownerPid = this process (alive), but nothing listens on the recorded port.
    const ghost = record({ env: { HTTPS_PROXY: 'http://127.0.0.1:1' } }) as ProxySessionRecord;
    expect(await isProxySessionAlive(ghost)).toBe(false);
  });

  test('a live pid WITH a listening proxy port is alive', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as net.AddressInfo).port;
    try {
      const live = record({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } }) as ProxySessionRecord;
      expect(await isProxySessionAlive(live)).toBe(true);
    } finally {
      server.close();
    }
  });

  test('an ended session is never alive', async () => {
    const ended = record({ endedAt: '2026-06-13T00:00:00.000Z' }) as ProxySessionRecord;
    expect(await isProxySessionAlive(ended)).toBe(false);
  });
});

describe('targeting a session by id for cleanup', () => {
  test('getProxySessionByToken finds an ended session only with includeEnded', async () => {
    await createProxySessionRecord(record({ uuid: 'uuid-1', id: 'abc12' }));
    await markProxySessionEnded('uuid-1');

    expect(await getProxySessionByToken('abc12')).toBeUndefined();
    const found = await getProxySessionByToken('abc12', { includeEnded: true });
    expect(found?.id).toBe('abc12');
    expect(found?.endedAt).toBeTruthy();
  });

  test('deleteProxySession removes one specific record', async () => {
    await createProxySessionRecord(record({ uuid: 'uuid-keep', id: 'keepp' }));
    await createProxySessionRecord(record({ uuid: 'uuid-drop', id: 'dropp' }));

    await deleteProxySession('uuid-drop');

    expect(existsSync(getProxySessionDir('uuid-drop'))).toBe(false);
    expect(existsSync(getProxySessionDir('uuid-keep'))).toBe(true);
  });
});

describe('pruneEndedProxySessions', () => {
  test('deletes ended session directories, keeps active ones', async () => {
    await createProxySessionRecord(record({ uuid: 'uuid-active', env: { HTTPS_PROXY: 'http://127.0.0.1:1' } }));
    await createProxySessionRecord(record({ uuid: 'uuid-ended' }));
    await markProxySessionEnded('uuid-ended');

    const removed = await pruneEndedProxySessions();

    expect(removed).toEqual(['abc12']); // the ended one's display id
    expect(existsSync(getProxySessionDir('uuid-ended'))).toBe(false);
    expect(existsSync(getProxySessionDir('uuid-active'))).toBe(true);
  });

  test('olderThanMs keeps recently-ended sessions', async () => {
    await createProxySessionRecord(record({ uuid: 'uuid-recent' }));
    await markProxySessionEnded('uuid-recent'); // ended just now

    const removed = await pruneEndedProxySessions({ olderThanMs: 60_000 });

    expect(removed).toEqual([]);
    expect(existsSync(getProxySessionDir('uuid-recent'))).toBe(true);
  });
});

describe('proxy session registry (session-as-record)', () => {
  test('creates a per-session directory holding session.json', async () => {
    await createProxySessionRecord(record());
    expect(existsSync(join(getProxySessionDir('uuid-1'), 'session.json'))).toBe(true);
  });

  test('round-trips the reloadable flag (daemon vs one-shot)', async () => {
    await createProxySessionRecord(record({ uuid: 'uuid-daemon', reloadable: true }));
    await createProxySessionRecord(record({ uuid: 'uuid-run' }));
    const byUuid = Object.fromEntries((await listProxySessions()).map((s) => [s.uuid, s]));
    expect(byUuid['uuid-daemon']!.reloadable).toBe(true);
    expect(byUuid['uuid-run']!.reloadable).toBeUndefined();
  });

  test('listProxySessions returns only active sessions by default', async () => {
    await createProxySessionRecord(record());
    const active = await listProxySessions();
    expect(active.map((s) => s.uuid)).toEqual(['uuid-1']);
  });

  test('markProxySessionEnded excludes from active but keeps the durable record', async () => {
    await createProxySessionRecord(record());
    // Drop a co-located file to prove the whole directory survives.
    await writeFile(join(getProxySessionDir('uuid-1'), 'grants.jsonl'), '{}\n');

    await markProxySessionEnded('uuid-1');

    expect(await listProxySessions()).toEqual([]);
    const all = await listProxySessions({ includeEnded: true });
    expect(all).toHaveLength(1);
    expect(all[0]!.endedAt).toBeTruthy();

    // Directory + co-located files remain — nothing is deleted on stop.
    expect(existsSync(join(getProxySessionDir('uuid-1'), 'session.json'))).toBe(true);
    expect(existsSync(join(getProxySessionDir('uuid-1'), 'grants.jsonl'))).toBe(true);
  });

  test('markProxySessionEnded is idempotent', async () => {
    await createProxySessionRecord(record());
    await markProxySessionEnded('uuid-1');
    const [first] = await listProxySessions({ includeEnded: true });
    await markProxySessionEnded('uuid-1');
    const [second] = await listProxySessions({ includeEnded: true });
    expect(second!.endedAt).toBe(first!.endedAt);
  });

  test('a session whose owner process is dead is not active', async () => {
    // pid 2^31-1 is effectively never a live process.
    await createProxySessionRecord(record({ uuid: 'uuid-dead', ownerPid: 2_147_483_647 }));
    expect(await listProxySessions()).toEqual([]);
    expect(await listProxySessions({ includeEnded: true })).toHaveLength(1);
  });
});
