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

import { spawnAsync, ExecError } from '@env-spec/utils/exec-helpers';
import { DashlanePluginInstance } from './dashlane-instance';
import { DashlaneManager, type ArgValue } from './dashlane-manager';
import { validateDeviceKeys, validateSecretRef } from './validators';

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
        expect(e.tip).toMatch(/npm.*install/i);
      }
    });

    it('only checks once per instance (caches the result)', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      await instance.ensureDcliInstalled();
      await instance.ensureDcliInstalled();
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

    it('trims trailing whitespace but preserves leading whitespace', async () => {
      mockSpawnAsync.mockResolvedValueOnce('6.2453.0');
      mockSpawnAsync.mockResolvedValueOnce('  secret  \n');
      const result = await instance.readReference('dl://abc123/password');
      expect(result).toBe('  secret');
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
  });

  describe('validateSecretRef', () => {
    it('accepts valid dl:// references', () => {
      expect(validateSecretRef('dl://abc123/password')).toBeUndefined();
    });

    it('rejects refs not starting with dl://', () => {
      expect(validateSecretRef('https://example.com')).toMatch(/dl:\/\//);
    });

    it('rejects bare dl:// without identifier', () => {
      expect(validateSecretRef('dl://')).toMatch(/identifier/);
    });
  });
});
