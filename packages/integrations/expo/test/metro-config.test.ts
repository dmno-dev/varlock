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
  VarlockExecError: class VarlockExecError extends Error {},
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
    mockExecSyncVarlock.mockReturnValue({ stdout: JSON.stringify(FAKE_ENV_GRAPH), stderr: '' });
  });

  afterEach(() => {
    if (savedVarlockEnv !== undefined) {
      process.env.__VARLOCK_ENV = savedVarlockEnv;
    } else {
      delete process.env.__VARLOCK_ENV;
    }
    delete (globalThis as any).__varlockLoadedEnv;
  });

  it('returns the same config object reference', () => {
    const input = { resolver: { sourceExts: ['ts'] } };
    const result = withVarlockMetroConfig(input);
    expect(result).toBe(input);
  });

  it('calls execSyncVarlock to load config', () => {
    withVarlockMetroConfig({});
    expect(mockExecSyncVarlock).toHaveBeenCalledOnce();
    expect(mockExecSyncVarlock).toHaveBeenCalledWith('load --format json-full', { fullResult: true });
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

  it('still installs custom resolver when __VARLOCK_ENV is already set', () => {
    process.env.__VARLOCK_ENV = '{}';
    const input = { resolver: {} } as any;
    withVarlockMetroConfig(input);
    expect(typeof input.resolver.resolveRequest).toBe('function');
  });

  it('throws when varlock config fails to load', () => {
    mockExecSyncVarlock.mockImplementation(() => {
      throw new Error('varlock CLI not found');
    });
    const input = { resolver: {} };
    expect(() => withVarlockMetroConfig(input)).toThrow('Failed to initialize varlock');
  });

  describe('custom resolver', () => {
    it('installs a resolveRequest on the config', () => {
      const input = {} as any;
      withVarlockMetroConfig(input);
      expect(typeof input.resolver.resolveRequest).toBe('function');
    });

    it('resolves varlock subpath imports to absolute file paths', () => {
      const input = {} as any;
      withVarlockMetroConfig(input);
      const fakeContext = { resolveRequest: vi.fn() };
      const result = input.resolver.resolveRequest(fakeContext, 'varlock/env', null);
      expect(result).toEqual({ type: 'sourceFile', filePath: expect.stringContaining('env') });
      expect(fakeContext.resolveRequest).not.toHaveBeenCalled();
    });

    it('falls through to context.resolveRequest for non-varlock imports', () => {
      const input = {} as any;
      withVarlockMetroConfig(input);
      const fallbackResult = { type: 'sourceFile', filePath: '/tmp/react.js' };
      const fakeContext = { resolveRequest: vi.fn().mockReturnValue(fallbackResult) };
      const result = input.resolver.resolveRequest(fakeContext, 'react', 'ios');
      expect(result).toEqual(fallbackResult);
      expect(fakeContext.resolveRequest).toHaveBeenCalledWith(fakeContext, 'react', 'ios');
    });

    it('delegates to existing resolveRequest if one was set', () => {
      const existingResolver = vi.fn().mockReturnValue({ type: 'sourceFile', filePath: '/custom' });
      const input = { resolver: { resolveRequest: existingResolver } } as any;
      withVarlockMetroConfig(input);
      const fakeContext = { resolveRequest: vi.fn() };
      input.resolver.resolveRequest(fakeContext, 'some-other-pkg', null);
      expect(existingResolver).toHaveBeenCalledWith(fakeContext, 'some-other-pkg', null);
      expect(fakeContext.resolveRequest).not.toHaveBeenCalled();
    });
  });

  describe('watchFolders', () => {
    it('adds varlock package directory to watchFolders', () => {
      const input = {} as any;
      withVarlockMetroConfig(input);
      expect(input.watchFolders).toBeDefined();
      expect(input.watchFolders.length).toBeGreaterThanOrEqual(1);
      expect(input.watchFolders[0]).toEqual(expect.stringContaining('varlock'));
    });

    it('preserves existing watchFolders', () => {
      const input = { watchFolders: ['/existing/folder'] } as any;
      withVarlockMetroConfig(input);
      expect(input.watchFolders).toContain('/existing/folder');
      expect(input.watchFolders.length).toBeGreaterThanOrEqual(2);
    });
  });
});
