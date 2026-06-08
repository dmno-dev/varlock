import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getProxyPlaceholderOverridesForEnvMock } = vi.hoisted(() => ({
  getProxyPlaceholderOverridesForEnvMock: vi.fn(),
}));

vi.mock('../../proxy/session-registry', () => ({
  getProxyPlaceholderOverridesForEnv: getProxyPlaceholderOverridesForEnvMock,
}));

import { loadVarlockEnvGraph } from '../load-graph';

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
    getProxyPlaceholderOverridesForEnvMock.mockReset();
    getProxyPlaceholderOverridesForEnvMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('uses schema value when no proxy placeholder overrides exist', async () => {
    const graph = await loadVarlockEnvGraph({ entryFilePaths: [tempDir] });
    await graph.resolveEnvValues();

    expect(graph.getResolvedEnvObject().API_KEY).toBe('real-secret');
  });

  test('applies proxy placeholder overrides when present', async () => {
    getProxyPlaceholderOverridesForEnvMock.mockResolvedValue({
      API_KEY: '<<PROXY_PLACEHOLDER>>',
    });

    const graph = await loadVarlockEnvGraph({ entryFilePaths: [tempDir] });
    await graph.resolveEnvValues();

    expect(graph.getResolvedEnvObject().API_KEY).toBe('<<PROXY_PLACEHOLDER>>');
  });
});
