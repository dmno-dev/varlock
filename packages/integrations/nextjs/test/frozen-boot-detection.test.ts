import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

const execSyncVarlock = vi.fn();
vi.mock('varlock/exec-sync-varlock', () => ({
  execSyncVarlock,
  VarlockExecError: class VarlockExecError extends Error {},
}));
vi.mock('varlock/env', () => ({
  initVarlockEnv: vi.fn(),
  resetRedactionMap: vi.fn(),
}));
vi.mock('varlock/patch-console', () => ({
  patchGlobalConsole: vi.fn(),
  patchProcessStreams: vi.fn(),
}));

const ENV_KEYS = [
  'NODE_ENV',
  '__VARLOCK_ENV',
  '__VARLOCK_NEXT_BUILD',
  '__VARLOCK_NEXT_FROZEN_BOOT_SOURCE',
  '__VARLOCK_NEXT_PROJECT_DIR',
  'NEXT_PRIVATE_BUILD_WORKER',
  'NEXT_PHASE',
  '__NEXT_PRIVATE_STANDALONE_CONFIG',
];

const graph = (value: string, extra?: object) => JSON.stringify({
  basePath: '/proj', sources: [], settings: {}, config: { APP_VAR: { value, isSensitive: false } }, ...extra,
});

let projectDir: string;
let savedEnv: Record<string, string | undefined>;
let savedArgv: Array<string>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  savedArgv = process.argv;
  execSyncVarlock.mockReset();

  // a previous build's frozen output (plaintext so the test needs no key)
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-next-frozen-detect-'));
  fs.mkdirSync(path.join(projectDir, '.next'));
  fs.writeFileSync(path.join(projectDir, '.next', 'required-server-files.json'), JSON.stringify({
    config: { env: { _VARLOCK_FROZEN_BUNDLE_ENV: graph('old-build-value', { frozen: true }) } },
  }));
});
afterEach(() => {
  process.argv = savedArgv;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(projectDir, { recursive: true, force: true });
});

async function loadEnvConfigFresh() {
  vi.resetModules();
  const { loadEnvConfig } = await import('../src/next-env-compat');
  return loadEnvConfig(projectDir, false);
}

describe('frozen boot detection', () => {
  it('a build worker keeps the current build resolution, even with an old frozen build present', async () => {
    process.argv = ['node', '/proj/node_modules/next/dist/compiled/jest-worker/processChild.js'];
    (process.env as Record<string, string>).NODE_ENV = 'production';
    process.env.__VARLOCK_NEXT_BUILD = '1';
    process.env.__VARLOCK_ENV = graph('current-build-value');

    await loadEnvConfigFresh();
    expect(JSON.parse(process.env.__VARLOCK_ENV!).config.APP_VAR.value).toBe('current-build-value');
    expect(process.env.__VARLOCK_NEXT_FROZEN_BOOT_SOURCE).toBeUndefined();
    expect(execSyncVarlock).not.toHaveBeenCalled();
  });

  it('a Next compiler worker (NEXT_PRIVATE_BUILD_WORKER) is never a server boot', async () => {
    process.argv = ['node', '/proj/node_modules/next/dist/build/webpack-build/impl.js'];
    (process.env as Record<string, string>).NODE_ENV = 'production';
    process.env.NEXT_PRIVATE_BUILD_WORKER = '1';
    process.env.__VARLOCK_ENV = graph('current-build-value');

    await loadEnvConfigFresh();
    expect(JSON.parse(process.env.__VARLOCK_ENV!).config.APP_VAR.value).toBe('current-build-value');
    expect(process.env.__VARLOCK_NEXT_FROZEN_BOOT_SOURCE).toBeUndefined();
  });

  it('a production custom server boots from the frozen build without calling the CLI', async () => {
    process.argv = ['node', path.join(projectDir, 'server.js')];
    (process.env as Record<string, string>).NODE_ENV = 'production';

    await loadEnvConfigFresh();
    expect(process.env.__VARLOCK_NEXT_FROZEN_BOOT_SOURCE)
      .toBe(path.resolve(projectDir, '.next', 'required-server-files.json'));
    expect(execSyncVarlock).not.toHaveBeenCalled();
  });
});
