import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { encryptEnvBlobSync } from 'varlock/encrypt-env';
import { STANDALONE_CONFIG_SOURCE } from '../src/freeze-into-bundle';

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
  '_VARLOCK_ENV_KEY',
];

const TEST_KEY = 'a'.repeat(64);

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

describe('server boot without the varlock CLI', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // build-time defines (see tsdown.config.mts)
    vi.stubGlobal('__VARLOCK_INTEGRATION_NAME__', '@varlock/nextjs-integration');
    vi.stubGlobal('__VARLOCK_INTEGRATION_VERSION__', '0.0.0-test');
    process.argv = ['node', path.join(projectDir, 'server.js')];
    (process.env as Record<string, string>).NODE_ENV = 'production';
    execSyncVarlock.mockImplementation(() => {
      throw new Error('Unable to find varlock executable');
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  function writeRecordedConfig(config: object) {
    fs.writeFileSync(path.join(projectDir, '.next', 'required-server-files.json'), JSON.stringify({ config }));
  }

  it('exits with the hint when the recorded config shows the build did not freeze', async () => {
    writeRecordedConfig({ env: { OTHER: 'x' } });

    await expect(loadEnvConfigFresh()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('no resolved env reached this Next.js server');
  });

  // Next drops `env` from required-server-files.json on Vercel
  // (`experimental.runtimeServerDeploymentId`), so its absence says nothing about freezing
  it('defers to the runtime when the recorded config has no env', async () => {
    writeRecordedConfig({ distDir: '.next' });

    const result = await loadEnvConfigFresh();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.parsedEnv).toEqual({});
    expect(process.env.__VARLOCK_NEXT_FROZEN_BOOT_SOURCE).toBeUndefined();
  });

  it('defers to the runtime when the standalone config has no env', async () => {
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify({ distDir: '.next' });

    const result = await loadEnvConfigFresh();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.parsedEnv).toEqual({});
  });

  // e.g. a custom distDir, which checkFrozenBootSource catches later
  it('defers to the runtime when there is no recorded config', async () => {
    fs.rmSync(path.join(projectDir, '.next', 'required-server-files.json'));

    const result = await loadEnvConfigFresh();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.parsedEnv).toEqual({});
  });

  it('defers to the runtime when the recorded config is unparseable', async () => {
    fs.writeFileSync(path.join(projectDir, '.next', 'required-server-files.json'), '{ not json');

    const result = await loadEnvConfigFresh();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.parsedEnv).toEqual({});
  });
});

describe('booting from a frozen build', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.argv = ['node', path.join(projectDir, 'server.js')];
    (process.env as Record<string, string>).NODE_ENV = 'production';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const loadedValue = () => JSON.parse(process.env.__VARLOCK_ENV!).config.APP_VAR.value;

  it('a standalone server boots from the frozen env in its config', async () => {
    // required-server-files.json still holds an older frozen env; the standalone config wins
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify({
      env: { _VARLOCK_FROZEN_BUNDLE_ENV: graph('standalone-value', { frozen: true }) },
    });

    await loadEnvConfigFresh();
    expect(loadedValue()).toBe('standalone-value');
    expect(process.env.__VARLOCK_NEXT_FROZEN_BOOT_SOURCE).toBe(STANDALONE_CONFIG_SOURCE);
    expect(execSyncVarlock).not.toHaveBeenCalled();
  });

  it('decrypts an encrypted frozen env with _VARLOCK_ENV_KEY', async () => {
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify({
      env: { _VARLOCK_FROZEN_BUNDLE_ENV: encryptEnvBlobSync(graph('secret-value', { frozen: true }), TEST_KEY) },
    });
    process.env._VARLOCK_ENV_KEY = TEST_KEY;

    await loadEnvConfigFresh();
    expect(loadedValue()).toBe('secret-value');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits when the frozen env is encrypted and _VARLOCK_ENV_KEY is not set', async () => {
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify({
      env: { _VARLOCK_FROZEN_BUNDLE_ENV: encryptEnvBlobSync(graph('secret-value', { frozen: true }), TEST_KEY) },
    });

    await expect(loadEnvConfigFresh()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('_VARLOCK_ENV_KEY is not set');
    expect(execSyncVarlock).not.toHaveBeenCalled();
  });

  it('ignores and warns about an ambient __VARLOCK_ENV from a different freeze', async () => {
    process.env.__VARLOCK_ENV = graph('ambient-value', { freezeId: 'other' });

    await loadEnvConfigFresh();
    expect(loadedValue()).toBe('old-build-value');
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('__VARLOCK_ENV set in the environment is ignored');
  });

  it('does not warn about an ambient __VARLOCK_ENV from the same freeze', async () => {
    const frozen = graph('frozen-value', { frozen: true, freezeId: 'same' });
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify({ env: { _VARLOCK_FROZEN_BUNDLE_ENV: frozen } });
    process.env.__VARLOCK_ENV = frozen;

    await loadEnvConfigFresh();
    expect(loadedValue()).toBe('frozen-value');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
