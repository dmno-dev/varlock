import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

const { mockExecSyncVarlock, mockInitVarlockEnv, mockPatchGlobalConsole } = vi.hoisted(() => ({
  mockExecSyncVarlock: vi.fn(),
  mockInitVarlockEnv: vi.fn(),
  mockPatchGlobalConsole: vi.fn(),
}));

vi.mock('varlock/exec-sync-varlock', () => ({
  execSyncVarlock: mockExecSyncVarlock,
}));

vi.mock('varlock/env', () => ({
  initVarlockEnv: mockInitVarlockEnv,
}));

vi.mock('varlock/patch-console', () => ({
  patchGlobalConsole: mockPatchGlobalConsole,
}));

import { withVarlockMetroConfig } from '../src/metro-config';

const FAKE_ENV_GRAPH = {
  basePath: '/tmp',
  sources: [],
  settings: {},
  config: {
    API_URL: { value: 'https://api.example.com', isSensitive: false },
    SECRET_KEY: { value: 's3cr3t', isSensitive: true },
  },
};

describe('withVarlockMetroConfig', () => {
  const savedVarlockEnv = process.env.__VARLOCK_ENV;

  beforeEach(() => {
    delete process.env.__VARLOCK_ENV;
    delete (globalThis as any).__varlockLoadedEnv;
    vi.clearAllMocks();
    mockExecSyncVarlock.mockReturnValue(JSON.stringify(FAKE_ENV_GRAPH));
  });

  afterEach(() => {
    if (savedVarlockEnv !== undefined) {
      process.env.__VARLOCK_ENV = savedVarlockEnv;
    } else {
      delete process.env.__VARLOCK_ENV;
    }
    delete (globalThis as any).__varlockLoadedEnv;
  });

  it('returns the config object unchanged', () => {
    const input = { resolver: { sourceExts: ['ts'] } };
    const result = withVarlockMetroConfig(input);
    expect(result).toBe(input);
  });

  it('calls execSyncVarlock to load config', () => {
    withVarlockMetroConfig({});
    expect(mockExecSyncVarlock).toHaveBeenCalledOnce();
    expect(mockExecSyncVarlock).toHaveBeenCalledWith('load --format json-full', {
      showLogsOnError: true,
    });
  });

  it('sets process.env.__VARLOCK_ENV with the JSON result', () => {
    withVarlockMetroConfig({});
    expect(process.env.__VARLOCK_ENV).toBe(JSON.stringify(FAKE_ENV_GRAPH));
  });

  it('sets globalThis.__varlockLoadedEnv with the parsed config', () => {
    withVarlockMetroConfig({});
    expect((globalThis as any).__varlockLoadedEnv).toEqual(FAKE_ENV_GRAPH);
  });

  it('calls initVarlockEnv and patchGlobalConsole', () => {
    withVarlockMetroConfig({});
    expect(mockInitVarlockEnv).toHaveBeenCalledOnce();
    expect(mockPatchGlobalConsole).toHaveBeenCalledOnce();
  });

  it('skips initialization when __VARLOCK_ENV is already set', () => {
    process.env.__VARLOCK_ENV = '{}';
    const input = { resolver: {} };
    const result = withVarlockMetroConfig(input);
    expect(result).toBe(input);
    expect(mockExecSyncVarlock).not.toHaveBeenCalled();
    expect(mockInitVarlockEnv).not.toHaveBeenCalled();
    expect(mockPatchGlobalConsole).not.toHaveBeenCalled();
  });

  it('logs a warning and still returns config on error', () => {
    mockExecSyncVarlock.mockImplementation(() => {
      throw new Error('varlock CLI not found');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = { resolver: {} };
    const result = withVarlockMetroConfig(input);
    expect(result).toBe(input);
    expect(errorSpy).toHaveBeenCalledOnce();
    const msg = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('Failed to initialize varlock');
    errorSpy.mockRestore();
  });
});
