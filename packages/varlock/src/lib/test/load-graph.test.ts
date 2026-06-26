import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getProxyResolutionViewForEnvMock, getActiveProxySessionMock } = vi.hoisted(() => ({
  getProxyResolutionViewForEnvMock: vi.fn(),
  getActiveProxySessionMock: vi.fn(),
}));

vi.mock('../../proxy/session-registry', () => ({
  getProxyResolutionViewForEnv: getProxyResolutionViewForEnvMock,
  // The schema-fingerprint guard (run by loadVarlockEnvGraph) resolves the active
  // session through this; no session in these tests.
  getActiveProxySession: getActiveProxySessionMock,
}));

import { loadVarlockEnvGraph } from '../load-graph';
import { PROXY_CHILD_ENV_VAR } from '../../proxy/env-vars';

describe('loadVarlockEnvGraph', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-load-graph-test-'));
    fs.writeFileSync(path.join(tempDir, '.env.schema'), [
      '# @defaultSensitive=false',
      '# ---',
      'API_KEY=real-secret',
      '',
    ].join('\n'));
    getProxyResolutionViewForEnvMock.mockReset();
    getProxyResolutionViewForEnvMock.mockResolvedValue(undefined);
    getActiveProxySessionMock.mockReset();
    getActiveProxySessionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('uses schema value when no proxy resolution view exists', async () => {
    const graph = await loadVarlockEnvGraph({ entryFilePaths: [tempDir] });
    await graph.resolveEnvValues();

    expect(graph.getResolvedEnvObject().API_KEY).toBe('real-secret');
  });

  test('applies a proxy placeholder directive when present', async () => {
    getProxyResolutionViewForEnvMock.mockResolvedValue({
      API_KEY: { kind: 'placeholder', value: '<<PROXY_PLACEHOLDER>>' },
    });

    const graph = await loadVarlockEnvGraph({ entryFilePaths: [tempDir] });
    await graph.resolveEnvValues();

    expect(graph.getResolvedEnvObject().API_KEY).toBe('<<PROXY_PLACEHOLDER>>');
  });

  test('resolves an omitted item to undefined without erroring', async () => {
    getProxyResolutionViewForEnvMock.mockResolvedValue({
      API_KEY: { kind: 'omit' },
    });

    const graph = await loadVarlockEnvGraph({ entryFilePaths: [tempDir] });
    await graph.resolveEnvValues();

    expect(graph.getResolvedEnvObject().API_KEY).toBeUndefined();
  });

  describe('fail-closed when a proxy child cannot resolve its session', () => {
    afterEach(() => {
      delete process.env[PROXY_CHILD_ENV_VAR];
    });

    test('refuses to load when the child marker is set but no session resolves', async () => {
      // Marker present (in-tree proxy child) but the session record is gone /
      // corrupt → no placeholder overlay. Resolving would re-expose the real
      // secret, so loadVarlockEnvGraph must throw instead.
      process.env[PROXY_CHILD_ENV_VAR] = '1';
      getActiveProxySessionMock.mockResolvedValue(undefined);

      await expect(loadVarlockEnvGraph({ entryFilePaths: [tempDir] })).rejects.toThrow(/session record is unavailable/i);
    });

    test('loads normally when the child marker is set and the session resolves', async () => {
      process.env[PROXY_CHILD_ENV_VAR] = '1';
      getActiveProxySessionMock.mockResolvedValue({ id: 'abc', uuid: 'u' } as any);
      getProxyResolutionViewForEnvMock.mockResolvedValue({
        API_KEY: { kind: 'placeholder', value: '<<PH>>' },
      });

      const graph = await loadVarlockEnvGraph({ entryFilePaths: [tempDir] });
      await graph.resolveEnvValues();

      expect(graph.getResolvedEnvObject().API_KEY).toBe('<<PH>>');
    });
  });
});
