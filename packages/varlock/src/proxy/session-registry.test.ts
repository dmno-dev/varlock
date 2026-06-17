import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';

import {
  createProxySessionRecord,
  getProxySessionDir,
  listProxySessions,
  markProxySessionEnded,
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
