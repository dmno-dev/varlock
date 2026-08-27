import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { execSync, execFileSync } from 'node:child_process';
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
    process.env.NODE_OPTIONS = '-r some-logger';
    try {
      execSyncVarlock('load');
    } finally {
      delete process.env.NODE_OPTIONS;
    }

    expect(execSync).toHaveBeenCalledWith(
      'varlock load',
      expect.objectContaining({
        env: expect.not.objectContaining({ NODE_OPTIONS: expect.anything() }),
      }),
    );
  });

  it('strips NODE_OPTIONS from an explicitly provided env too', () => {
    execSyncVarlock('load', {
      env: {
        ...process.env,
        NODE_OPTIONS: '-r some-logger',
      },
    });

    expect(execSync).toHaveBeenCalledWith(
      'varlock load',
      expect.objectContaining({
        env: expect.not.objectContaining({ NODE_OPTIONS: expect.anything() }),
      }),
    );
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
});
