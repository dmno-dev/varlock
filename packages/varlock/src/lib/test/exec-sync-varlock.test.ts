import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { integrationTelemetryEnv, execSyncVarlock } from '../exec-sync-varlock';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => Buffer.from('ok')),
  execFileSync: vi.fn(() => Buffer.from('ok')),
}));

describe('execSyncVarlock integration telemetry', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockClear();
    vi.mocked(execFileSync).mockClear();
  });

  afterEach(() => {
    delete process.env.__VARLOCK_INTEGRATION;
    vi.unstubAllGlobals();
  });

  it('integrationTelemetryEnv formats __VARLOCK_INTEGRATION', () => {
    expect(integrationTelemetryEnv('@varlock/vite-integration', '1.1.3')).toEqual({
      __VARLOCK_INTEGRATION: '@varlock/vite-integration@1.1.3',
    });
  });

  it('integration-provided identity overrides any inherited __VARLOCK_INTEGRATION (internal use only)', () => {
    execSyncVarlock('load', {
      env: {
        ...process.env,
        __VARLOCK_INTEGRATION: '@custom/explicit@9.9.9',
      },
      integrationTelemetry: {
        name: '@varlock/vite-integration',
        version: '1.1.3',
      },
    });

    expect(execSync).toHaveBeenCalledWith(
      'varlock load',
      expect.objectContaining({
        env: expect.objectContaining({
          __VARLOCK_INTEGRATION: '@varlock/vite-integration@1.1.3',
        }),
      }),
    );
  });

  it('strips NODE_OPTIONS so parent-process preloads cannot corrupt the CLI stdio protocol', () => {
    vi.stubEnv('NODE_OPTIONS', '-r some-logger');
    try {
      execSyncVarlock('load');
    } finally {
      vi.unstubAllEnvs();
    }

    expect(execSync).toHaveBeenCalledWith(
      'varlock load',
      expect.objectContaining({
        env: expect.not.objectContaining({ NODE_OPTIONS: expect.anything() }),
      }),
    );
  });

  it('strips NODE_OPTIONS from an explicitly provided env too, including casing variants (Windows)', () => {
    execSyncVarlock('load', {
      env: {
        ...process.env,
        NODE_OPTIONS: '-r some-logger',
        Node_Options: '-r some-logger',
      },
    });

    const childEnv = vi.mocked(execSync).mock.calls[0][1]!.env!;
    expect(Object.keys(childEnv).filter((key) => key.toUpperCase() === 'NODE_OPTIONS')).toEqual([]);
  });

  it('sets __VARLOCK_INTEGRATION when integrationTelemetry is provided', () => {
    execSyncVarlock('load', {
      integrationTelemetry: {
        name: '@varlock/nextjs-integration',
        version: '1.1.3',
      },
    });

    expect(execSync).toHaveBeenCalledWith(
      'varlock load',
      expect.objectContaining({
        env: expect.objectContaining({
          __VARLOCK_INTEGRATION: '@varlock/nextjs-integration@1.1.3',
        }),
      }),
    );
  });

  it('finds a workspace CLI relative to a Bun-compiled executable', () => {
    const originalExecPath = process.execPath;
    process.execPath = '/app/apps/server/dist/server';
    vi.stubGlobal('Bun', { isStandaloneExecutable: true });
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('varlock: not found'), { status: 127 });
    });
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      return filePath === '/app/apps/server/node_modules/.bin'
        || filePath === '/app/apps/server/node_modules/.bin/varlock';
    });

    try {
      execSyncVarlock('load', { callerDir: '/$bunfs/root' });
    } finally {
      process.execPath = originalExecPath;
      existsSyncSpy.mockRestore();
    }

    expect(execFileSync).toHaveBeenCalledWith(
      '/app/apps/server/node_modules/.bin/varlock',
      ['load'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('does not search relative to the runtime executable outside a Bun-compiled executable', () => {
    const originalExecPath = process.execPath;
    process.execPath = '/runtime/bin/bun';
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/project');
    vi.stubGlobal('Bun', { isStandaloneExecutable: false });
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('varlock: not found'), { status: 127 });
    });
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      return filePath === '/runtime/bin/node_modules/.bin'
        || filePath === '/runtime/bin/node_modules/.bin/varlock'
        || filePath === '/project/node_modules/.bin'
        || filePath === '/project/node_modules/.bin/varlock';
    });

    try {
      execSyncVarlock('load');
    } finally {
      process.execPath = originalExecPath;
      cwdSpy.mockRestore();
      existsSyncSpy.mockRestore();
    }

    expect(execFileSync).toHaveBeenCalledWith(
      '/project/node_modules/.bin/varlock',
      ['load'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });
});
