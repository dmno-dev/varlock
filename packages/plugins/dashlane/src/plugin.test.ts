import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

// Mock exec-helpers before importing anything that uses it
vi.mock('@env-spec/utils/exec-helpers', () => ({
  spawnAsync: vi.fn(),
  ExecError: class ExecError extends Error {
    constructor(
      readonly exitCode: number,
      readonly signal: NodeJS.Signals | null,
      readonly data: string = 'command gave no output',
    ) {
      super(data);
    }
  },
}));

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

import { spawnAsync, ExecError } from '@env-spec/utils/exec-helpers';
import { spawnSync } from 'node:child_process';
import { DashlanePluginInstance } from './dashlane-instance';
import { DashlaneManager, type ArgValue } from './dashlane-manager';
import { validateDeviceKeys } from './validators';

const mockSpawnAsync = vi.mocked(spawnAsync);

/** Helper to create a mock ArgValue */
function mockArg(value: unknown, isStatic = true): ArgValue {
  return {
    isStatic,
    staticValue: isStatic ? value : undefined,
    resolve: vi.fn().mockResolvedValue(value),
  };
}

/** Simple error classes matching plugin.ERRORS shape */
class SchemaError extends Error {
  tip?: string;
  constructor(msg: string, opts?: { tip?: string }) {
    super(msg);
    this.tip = opts?.tip;
  }
}
class ResolutionError extends Error {
  tip?: string;
  constructor(msg: string, opts?: { tip?: string }) {
    super(msg);
    this.tip = opts?.tip;
  }
}

const mockErrors = { SchemaError, ResolutionError };

describe('DashlanePluginInstance', () => {
  let instance: DashlanePluginInstance;

  beforeEach(() => {
    vi.resetAllMocks();
    instance = new DashlanePluginInstance('test', ResolutionError);
    instance.configure(); // autoSync off by default
  });

  describe('constructor', () => {
    it('stores the instance id', () => {
      expect(instance.id).toBe('test');
    });
  });

  describe('configure + spawnEnv behavior', () => {
    it('does not pass env to dcli when no service device keys are set', async () => {
      instance.configure();
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('secret\n');
      await instance.readReference('dl://abc/password');
      expect(mockSpawnAsync).toHaveBeenCalledWith('dcli', ['read', 'dl://abc/password'], undefined);
    });

    it('passes DASHLANE_SERVICE_DEVICE_KEYS env to dcli when keys are set', async () => {
      instance.configure('dls_key_data');
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('secret\n');
      await instance.readReference('dl://abc/password');
      expect(mockSpawnAsync).toHaveBeenCalledWith(
        'dcli',
        ['read', 'dl://abc/password'],
        expect.objectContaining({
          env: expect.objectContaining({
            DASHLANE_SERVICE_DEVICE_KEYS: 'dls_key_data',
          }),
        }),
      );
    });

    it('inherits process.env when keys are set', async () => {
      instance.configure('dls_key_data');
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('secret\n');
      await instance.readReference('dl://abc/password');
      const envCall = mockSpawnAsync.mock.calls.find((c) => c[1]?.[0] === 'read');
      expect(envCall?.[2]?.env?.PATH).toBeDefined();
    });
  });

  describe('ensureDcliInstalled', () => {
    it('succeeds when dcli --version returns cleanly', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      await instance.ensureDcliInstalled();
      expect(mockSpawnAsync).toHaveBeenCalledWith('dcli', ['--version'], undefined);
    });

    it('throws ResolutionError with install tip when dcli is not found', async () => {
      const err = new Error('spawn dcli ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      mockSpawnAsync.mockRejectedValueOnce(err);

      try {
        await instance.ensureDcliInstalled();
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ResolutionError);
        expect(e.tip).toMatch(/cli\.dashlane\.com/i);
      }
    });

    it('only checks once per instance (caches the result)', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      await instance.ensureDcliInstalled();
      await instance.ensureDcliInstalled();
      expect(mockSpawnAsync).toHaveBeenCalledTimes(1);
    });

    it('retries dcli check after ENOENT failure', async () => {
      const err = new Error('spawn dcli ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      mockSpawnAsync.mockRejectedValueOnce(err);
      await expect(instance.ensureDcliInstalled()).rejects.toThrow(ResolutionError);

      // Second attempt should retry, not return cached rejection
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      await instance.ensureDcliInstalled();
      expect(mockSpawnAsync).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent calls into a single spawn', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      await Promise.all([
        instance.ensureDcliInstalled(),
        instance.ensureDcliInstalled(),
        instance.ensureDcliInstalled(),
      ]);
      expect(mockSpawnAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('readReference', () => {
    it('calls dcli read with the dl:// URI', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('my-secret-value\n');
      const result = await instance.readReference('dl://abc123/password');
      expect(mockSpawnAsync).toHaveBeenCalledWith('dcli', ['read', 'dl://abc123/password'], undefined);
      expect(result).toBe('my-secret-value');
    });

    it('strips trailing newline but preserves other whitespace', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('  secret  \n');
      const result = await instance.readReference('dl://abc123/password');
      expect(result).toBe('  secret  ');
    });

    it('caches repeated lookups for the same reference', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('secret-val\n');
      await instance.readReference('dl://abc123/password');
      const result = await instance.readReference('dl://abc123/password');
      expect(mockSpawnAsync).toHaveBeenCalledTimes(2); // dcli check + 1 read
      expect(result).toBe('secret-val');
    });

    it('does not cache different references', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('val1\n');
      mockSpawnAsync.mockResolvedValueOnce('val2\n');
      await instance.readReference('dl://abc/password');
      await instance.readReference('dl://def/password');
      expect(mockSpawnAsync).toHaveBeenCalledTimes(3); // dcli check + 2 reads
    });

    it('throws ResolutionError with tip on not-found', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockRejectedValueOnce(new ExecError(1, null, 'No matching item found'));
      try {
        await instance.readReference('dl://bad/ref');
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ResolutionError);
        expect(e.message).toMatch(/not found/i);
        expect(e.tip).toBeDefined();
      }
    });

    it('throws ResolutionError on auth failure', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockRejectedValueOnce(new ExecError(1, null, 'Authentication failed'));
      try {
        await instance.readReference('dl://abc/password');
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ResolutionError);
        expect(e.message).toMatch(/authentication/i);
        expect(e.tip).toMatch(/dcli sync/);
      }
    });

    it('throws ResolutionError on vault locked/sync error', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockRejectedValueOnce(new ExecError(1, null, 'Vault is locked'));
      try {
        await instance.readReference('dl://abc/password');
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ResolutionError);
        expect(e.tip).toMatch(/dcli sync/);
        expect(e.tip).toMatch(/autoSync/);
      }
    });

    it('rejects bare dl:// with no path', async () => {
      try {
        await instance.readReference('dl://');
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ResolutionError);
        expect(e.message).toMatch(/invalid/i);
      }
    });

    it('rejects URIs that do not start with dl://', async () => {
      try {
        await instance.readReference('https://example.com');
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ResolutionError);
        expect(e.message).toMatch(/invalid/i);
        expect(e.tip).toMatch(/dl:\/\//);
      }
    });

    it('passes spawnEnv when service device keys are set', async () => {
      const inst2 = new DashlanePluginInstance('test2', ResolutionError);
      inst2.configure('dls_key_data');
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('secret\n');
      await inst2.readReference('dl://abc/password');

      const readCall = mockSpawnAsync.mock.calls.find((c) => c[1]?.[0] === 'read');
      expect(readCall?.[2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            DASHLANE_SERVICE_DEVICE_KEYS: 'dls_key_data',
          }),
        }),
      );
    });
  });

  describe('syncOnce', () => {
    it('calls dcli sync before first read when autoSync is true', async () => {
      instance.configure(undefined, { autoSync: true });
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0'); // --version
      mockSpawnAsync.mockResolvedValueOnce(''); // sync
      mockSpawnAsync.mockResolvedValueOnce('secret\n'); // read
      await instance.readReference('dl://abc/password');
      expect(mockSpawnAsync).toHaveBeenCalledWith('dcli', ['sync'], undefined);
    });

    it('does not call dcli sync by default', async () => {
      instance.configure();
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('secret\n');
      await instance.readReference('dl://abc/password');
      const syncCall = mockSpawnAsync.mock.calls.find((c) => c[1]?.[0] === 'sync');
      expect(syncCall).toBeUndefined();
    });

    it('only syncs once across multiple reads', async () => {
      instance.configure(undefined, { autoSync: true });
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0'); // --version
      mockSpawnAsync.mockResolvedValueOnce(''); // sync
      mockSpawnAsync.mockResolvedValueOnce('val1\n'); // read 1
      mockSpawnAsync.mockResolvedValueOnce('val2\n'); // read 2
      await instance.readReference('dl://abc/password');
      await instance.readReference('dl://def/password');
      const syncCalls = mockSpawnAsync.mock.calls.filter((c) => c[1]?.[0] === 'sync');
      expect(syncCalls).toHaveLength(1);
    });

    it('deduplicates concurrent sync calls into a single spawn', async () => {
      instance.configure(undefined, { autoSync: true });
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0'); // --version
      mockSpawnAsync.mockResolvedValueOnce(''); // sync
      mockSpawnAsync.mockResolvedValueOnce('val1\n'); // read 1
      mockSpawnAsync.mockResolvedValueOnce('val2\n'); // read 2
      await Promise.all([
        instance.readReference('dl://abc/password'),
        instance.readReference('dl://def/password'),
      ]);
      const syncCalls = mockSpawnAsync.mock.calls.filter((c) => c[1]?.[0] === 'sync');
      expect(syncCalls).toHaveLength(1);
    });

    it('does not block reads when sync fails', async () => {
      instance.configure(undefined, { autoSync: true });
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0'); // --version
      mockSpawnAsync.mockRejectedValueOnce(new Error('network error')); // sync fails
      mockSpawnAsync.mockResolvedValueOnce('secret\n'); // read still works
      const result = await instance.readReference('dl://abc/password');
      expect(result).toBe('secret');
    });
  });

  describe('lockVaultSync', () => {
    const mockSpawnSync = vi.mocked(spawnSync);

    it('does not call spawnSync when configure was never called', () => {
      const unconfigured = new DashlanePluginInstance('x', ResolutionError);
      unconfigured.lockVaultSync();
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('locks by default in headless mode', () => {
      instance.configure('dls_key_data');
      instance.lockVaultSync();
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'dcli',
        ['lock'],
        expect.objectContaining({
          timeout: 5000,
          stdio: 'ignore',
          env: expect.objectContaining({
            DASHLANE_SERVICE_DEVICE_KEYS: 'dls_key_data',
          }),
        }),
      );
    });

    it('does not lock by default in interactive mode', () => {
      instance.configure();
      instance.lockVaultSync();
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('locks in interactive mode when lockOnExit is explicitly true', () => {
      instance.configure(undefined, { lockOnExit: true });
      instance.lockVaultSync();
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'dcli',
        ['lock'],
        expect.objectContaining({ timeout: 5000, stdio: 'ignore' }),
      );
    });

    it('does not lock in headless mode when lockOnExit is explicitly false', () => {
      instance.configure('dls_key_data', { lockOnExit: false });
      instance.lockVaultSync();
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('does not throw when lock fails', () => {
      mockSpawnSync.mockImplementation(() => { throw new Error('lock failed'); });
      instance.configure('dls_key_data');
      expect(() => instance.lockVaultSync()).not.toThrow();
    });
  });
});

describe('DashlaneManager', () => {
  let manager: DashlaneManager;

  beforeEach(() => {
    vi.resetAllMocks();
    manager = new DashlaneManager(mockErrors);
  });

  describe('processInit (@initDashlane process phase)', () => {
    it('creates a default instance when no args provided', () => {
      const result = manager.processInit();
      expect(result.id).toBe('_default');
      expect(manager.instances._default).toBeInstanceOf(DashlanePluginInstance);
    });

    it('creates a named instance when id is provided', () => {
      const result = manager.processInit({ id: mockArg('prod') });
      expect(result.id).toBe('prod');
      expect(manager.instances.prod).toBeInstanceOf(DashlanePluginInstance);
    });

    it('rejects non-static id', () => {
      expect(() => {
        manager.processInit({ id: mockArg('prod', false) });
      }).toThrow(SchemaError);
    });

    it('rejects duplicate instance ids', () => {
      manager.processInit({ id: mockArg('prod') });
      expect(() => {
        manager.processInit({ id: mockArg('prod') });
      }).toThrow(/already initialized/);
    });

    it('passes through serviceDeviceKeysResolver', () => {
      const keysArg = mockArg('dls_abc_123');
      const result = manager.processInit({ serviceDeviceKeys: keysArg });
      expect(result.serviceDeviceKeysResolver).toBe(keysArg);
    });

    it('extracts autoSync from args', () => {
      const result = manager.processInit({ autoSync: mockArg(true) });
      expect(result.autoSync).toBe(true);
    });

    it('defaults autoSync to false', () => {
      const result = manager.processInit();
      expect(result.autoSync).toBe(false);
    });

    it('rejects non-static autoSync', () => {
      expect(() => {
        manager.processInit({ autoSync: mockArg(true, false) });
      }).toThrow(SchemaError);
    });

    it('extracts lockOnExit from args', () => {
      const result = manager.processInit({ lockOnExit: mockArg(true) });
      expect(result.lockOnExit).toBe(true);
    });

    it('defaults lockOnExit to undefined (instance decides)', () => {
      const result = manager.processInit();
      expect(result.lockOnExit).toBeUndefined();
    });

    it('rejects non-static lockOnExit', () => {
      expect(() => {
        manager.processInit({ lockOnExit: mockArg(false, false) });
      }).toThrow(SchemaError);
    });
  });

  describe('executeInit (@initDashlane execute phase)', () => {
    it('configures instance with resolved service device keys', async () => {
      const processResult = manager.processInit({
        serviceDeviceKeys: mockArg('dls_key_value'),
      });
      await manager.executeInit(processResult);

      const instance = manager.instances._default;
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('secret\n');
      await instance.readReference('dl://abc/password');
      const readCall = mockSpawnAsync.mock.calls.find((c) => c[1]?.[0] === 'read');
      expect(readCall?.[2]?.env?.DASHLANE_SERVICE_DEVICE_KEYS).toBe('dls_key_value');
    });

    it('configures instance without keys for interactive mode', async () => {
      const processResult = manager.processInit();
      await manager.executeInit(processResult);

      const instance = manager.instances._default;
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('secret\n');
      await instance.readReference('dl://abc/password');
      expect(mockSpawnAsync).toHaveBeenCalledWith('dcli', ['read', 'dl://abc/password'], undefined);
    });

    it('passes autoSync to configure', async () => {
      const processResult = manager.processInit({
        autoSync: mockArg(true),
      });
      await manager.executeInit(processResult);

      const inst = manager.instances._default;
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0'); // --version
      mockSpawnAsync.mockResolvedValueOnce(''); // sync
      mockSpawnAsync.mockResolvedValueOnce('secret\n'); // read
      await inst.readReference('dl://abc/password');
      const syncCall = mockSpawnAsync.mock.calls.find((c) => c[1]?.[0] === 'sync');
      expect(syncCall).toBeDefined();
    });

    it('ignores non-string resolved values', async () => {
      const processResult = manager.processInit({
        serviceDeviceKeys: mockArg(undefined),
      });
      await manager.executeInit(processResult);

      const instance = manager.instances._default;
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('secret\n');
      await instance.readReference('dl://abc/password');
      expect(mockSpawnAsync).toHaveBeenCalledWith('dcli', ['read', 'dl://abc/password'], undefined);
    });
  });

  describe('getInstance', () => {
    it('returns the default instance', () => {
      manager.processInit();
      const instance = manager.getInstance('_default');
      expect(instance).toBeInstanceOf(DashlanePluginInstance);
    });

    it('returns a named instance', () => {
      manager.processInit({ id: mockArg('prod') });
      const instance = manager.getInstance('prod');
      expect(instance.id).toBe('prod');
    });

    it('throws when no instances exist', () => {
      expect(() => manager.getInstance('_default')).toThrow(
        /No Dashlane plugin instances found/,
      );
    });

    it('throws for unknown instance id with available ids', () => {
      manager.processInit({ id: mockArg('prod') });
      expect(() => manager.getInstance('staging')).toThrow(
        /not found/,
      );
    });

    it('lockAllSync calls lockVaultSync on all instances', async () => {
      manager.processInit({
        id: mockArg('a'),
        serviceDeviceKeys: mockArg('dls_key_a'),
      });
      await manager.executeInit({
        id: 'a',
        serviceDeviceKeysResolver: mockArg('dls_key_a'),
      });
      manager.processInit({ id: mockArg('b') });
      await manager.executeInit({ id: 'b' });

      const lockSpy = vi.spyOn(manager.instances.a, 'lockVaultSync');
      const lockSpy2 = vi.spyOn(manager.instances.b, 'lockVaultSync');
      manager.lockAllSync();
      expect(lockSpy).toHaveBeenCalled();
      expect(lockSpy2).toHaveBeenCalled();
    });

    it('registerExitHandler only registers once', () => {
      const onSpy = vi.spyOn(process, 'on');
      manager.registerExitHandler();
      manager.registerExitHandler();
      const exitCalls = onSpy.mock.calls.filter((c) => c[0] === 'exit');
      expect(exitCalls).toHaveLength(1);
      onSpy.mockRestore();
    });

    it('gives helpful tip when default instance not found but others exist', () => {
      manager.processInit({ id: mockArg('prod') });
      try {
        manager.getInstance('_default');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.tip).toContain('prod');
      }
    });
  });
});

describe('validators', () => {
  describe('validateDeviceKeys', () => {
    it('accepts valid dls_ keys', () => {
      expect(validateDeviceKeys('dls_abc123_payload_data')).toBeUndefined();
    });

    it('rejects keys not starting with dls_', () => {
      expect(validateDeviceKeys('invalid_key')).toMatch(/dls_/);
    });

    it('rejects empty strings', () => {
      expect(validateDeviceKeys('')).toMatch(/dls_/);
    });

    it('rejects too-short keys', () => {
      expect(validateDeviceKeys('dls_ab')).toMatch(/too short/);
    });

    it('rejects non-string values', () => {
      expect(validateDeviceKeys(123 as any)).toMatch(/string/);
      expect(validateDeviceKeys(null as any)).toMatch(/string/);
    });
  });
});
