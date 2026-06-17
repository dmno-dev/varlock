import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';

import {
  newReloadRequestId,
  readReloadRequest,
  readReloadResult,
  writeReloadRequest,
  writeReloadResult,
} from './reload-channel';
import { getProxySessionDir } from './session-registry';

// Redirect the session dir into a throwaway XDG_CONFIG_HOME (paths resolve lazily).
let tmpDir: string;
let prevXdg: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(os.tmpdir(), 'varlock-reload-test-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await rm(tmpDir, { recursive: true, force: true });
});

describe('proxy reload channel', () => {
  test('round-trips a request and a result, co-located in the session dir', async () => {
    const uuid = 'sess-1';
    const requestId = newReloadRequestId();
    expect(requestId).toMatch(/^[0-9a-f]+$/);

    await writeReloadRequest(uuid, { requestId, requestedAt: '2026-06-16T00:00:00.000Z', entryPaths: ['./envs'] });
    const req = await readReloadRequest(uuid);
    expect(req).toMatchObject({ requestId, entryPaths: ['./envs'] });
    expect(existsSync(join(getProxySessionDir(uuid), 'reload-request.json'))).toBe(true);

    await writeReloadResult(uuid, {
      requestId, status: 'done', completedAt: '2026-06-16T00:00:01.000Z', managedItemCount: 3,
    });
    const res = await readReloadResult(uuid);
    expect(res).toMatchObject({ requestId, status: 'done', managedItemCount: 3 });
  });

  test('returns undefined when no request/result exists', async () => {
    expect(await readReloadRequest('missing')).toBeUndefined();
    expect(await readReloadResult('missing')).toBeUndefined();
  });

  test('a later write replaces the earlier one (last request wins)', async () => {
    const uuid = 'sess-2';
    await writeReloadRequest(uuid, { requestId: 'a', requestedAt: '2026-06-16T00:00:00.000Z' });
    await writeReloadRequest(uuid, { requestId: 'b', requestedAt: '2026-06-16T00:00:02.000Z' });
    expect((await readReloadRequest(uuid))?.requestId).toBe('b');
  });
});
