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

/** Pretend only the given paths exist on disk (bin dirs and bins) */
function stubExistingPaths(paths: Array<string>) {
  const existing = new Set(paths);
  return vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => existing.has(String(filePath)));
}

describe('execSyncVarlock integration telemetry', () => {
  let existsSyncSpy: ReturnType<typeof stubExistingPaths>;

  beforeEach(() => {
    vi.mocked(execSync).mockClear();
    vi.mocked(execFileSync).mockClear();
    // no local install anywhere, so these exercise the PATH fallback
    existsSyncSpy = stubExistingPaths([]);
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
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

  it('passes the merged env to a local bin as well', () => {
    existsSyncSpy.mockRestore();
    existsSyncSpy = stubExistingPaths(['/app/node_modules/.bin', '/app/node_modules/.bin/varlock']);
    vi.stubEnv('NODE_OPTIONS', '-r some-logger');
    try {
      execSyncVarlock('load', {
        cwd: '/app',
        integrationTelemetry: { name: '@varlock/vite-integration', version: '1.1.3' },
      });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(execFileSync).toHaveBeenCalledWith(
      '/app/node_modules/.bin/varlock',
      ['load'],
      expect.objectContaining({
        env: expect.objectContaining({ __VARLOCK_INTEGRATION: '@varlock/vite-integration@1.1.3' }),
      }),
    );
    const childEnv = vi.mocked(execFileSync).mock.calls[0][2]!.env!;
    expect(childEnv.NODE_OPTIONS).toBeUndefined();
  });
});

describe('execSyncVarlock CLI resolution order', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let existsSyncSpy: ReturnType<typeof stubExistingPaths>;

  beforeEach(() => {
    vi.mocked(execSync).mockClear();
    vi.mocked(execFileSync).mockClear();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/project');
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    existsSyncSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  it('prefers a local node_modules/.bin/varlock over the PATH lookup', () => {
    existsSyncSpy = stubExistingPaths([
      '/project/node_modules/.bin',
      '/project/node_modules/.bin/varlock',
    ]);

    execSyncVarlock('load');

    expect(execFileSync).toHaveBeenCalledWith(
      '/project/node_modules/.bin/varlock',
      ['load'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('walks up from cwd to find a local bin in a parent directory', () => {
    existsSyncSpy = stubExistingPaths([
      '/project/node_modules/.bin', // exists but has no varlock (hoisted monorepo root)
      '/node_modules/.bin',
      '/node_modules/.bin/varlock',
    ]);

    execSyncVarlock('load');

    expect(execFileSync).toHaveBeenCalledWith(
      '/node_modules/.bin/varlock',
      ['load'],
      expect.anything(),
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('stops the walk-up at the git root so a stray install above the repo cannot win', () => {
    existsSyncSpy = stubExistingPaths([
      '/project/.git',
      '/node_modules/.bin',
      '/node_modules/.bin/varlock', // e.g. an accidental install in a parent dir
    ]);

    execSyncVarlock('load');

    expect(execSync).toHaveBeenCalledWith('varlock load', expect.anything());
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('still finds a bin at the git root itself', () => {
    existsSyncSpy = stubExistingPaths([
      '/monorepo/.git',
      '/monorepo/node_modules/.bin',
      '/monorepo/node_modules/.bin/varlock',
    ]);
    cwdSpy.mockReturnValue('/monorepo/apps/web');

    execSyncVarlock('load');

    expect(execFileSync).toHaveBeenCalledWith(
      '/monorepo/node_modules/.bin/varlock',
      ['load'],
      expect.anything(),
    );
  });

  it('falls back to the shell PATH lookup only when there is no local install', () => {
    existsSyncSpy = stubExistingPaths([]);

    const result = execSyncVarlock('load --format json');

    expect(execSync).toHaveBeenCalledWith(
      'varlock load --format json',
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(execFileSync).not.toHaveBeenCalled();
    expect(result).toBe('ok');
  });

  it('uses a local bin found from callerDir even when process.cwd() has none', () => {
    existsSyncSpy = stubExistingPaths([
      '/monorepo/packages/app/node_modules/.bin',
      '/monorepo/packages/app/node_modules/.bin/varlock',
    ]);

    execSyncVarlock('load', { callerDir: '/monorepo/packages/app/node_modules/varlock/dist' });

    expect(execFileSync).toHaveBeenCalledWith(
      '/monorepo/packages/app/node_modules/.bin/varlock',
      ['load'],
      expect.anything(),
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('searches an explicit cwd before callerDir', () => {
    existsSyncSpy = stubExistingPaths([
      '/explicit/node_modules/.bin',
      '/explicit/node_modules/.bin/varlock',
      '/caller/node_modules/.bin',
      '/caller/node_modules/.bin/varlock',
    ]);

    execSyncVarlock('load', { cwd: '/explicit', callerDir: '/caller' });

    expect(execFileSync).toHaveBeenCalledWith(
      '/explicit/node_modules/.bin/varlock',
      ['load'],
      expect.objectContaining({ cwd: '/explicit' }),
    );
  });

  it('throws "Unable to find varlock executable" when neither a local bin nor PATH has varlock', () => {
    existsSyncSpy = stubExistingPaths([]);
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('varlock: not found'), { status: 127 });
    });

    expect(() => execSyncVarlock('load')).toThrow('Unable to find varlock executable');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('throws "Unable to find varlock executable" when the shell itself is missing (ENOENT)', () => {
    existsSyncSpy = stubExistingPaths([]);
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn /bin/sh ENOENT'), { code: 'ENOENT' });
    });

    expect(() => execSyncVarlock('load')).toThrow('Unable to find varlock executable');
  });

  it('surfaces the real CLI error when the PATH varlock runs but fails', () => {
    existsSyncSpy = stubExistingPaths([]);
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('boom'), { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('bad schema') });
    });

    expect(() => execSyncVarlock('load')).toThrow('boom');
  });

  it('finds a workspace CLI relative to a Bun-compiled executable', () => {
    const originalExecPath = process.execPath;
    process.execPath = '/app/apps/server/dist/server';
    vi.stubGlobal('Bun', { isStandaloneExecutable: true });
    existsSyncSpy = stubExistingPaths([
      '/app/apps/server/node_modules/.bin',
      '/app/apps/server/node_modules/.bin/varlock',
    ]);

    try {
      execSyncVarlock('load', { callerDir: '/$bunfs/root' });
    } finally {
      process.execPath = originalExecPath;
    }

    expect(execFileSync).toHaveBeenCalledWith(
      '/app/apps/server/node_modules/.bin/varlock',
      ['load'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('does not search relative to the runtime executable outside a Bun-compiled executable', () => {
    const originalExecPath = process.execPath;
    process.execPath = '/runtime/bin/bun';
    vi.stubGlobal('Bun', { isStandaloneExecutable: false });
    existsSyncSpy = stubExistingPaths([
      '/runtime/bin/node_modules/.bin',
      '/runtime/bin/node_modules/.bin/varlock',
      '/project/node_modules/.bin',
      '/project/node_modules/.bin/varlock',
    ]);

    try {
      execSyncVarlock('load');
    } finally {
      process.execPath = originalExecPath;
    }

    expect(execFileSync).toHaveBeenCalledWith(
      '/project/node_modules/.bin/varlock',
      ['load'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });
});
