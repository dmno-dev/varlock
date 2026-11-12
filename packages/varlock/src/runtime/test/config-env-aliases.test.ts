/*
  `_VARLOCK_*` config vars can also be set without the leading underscore, for platforms that
  reject env var names starting with `_` (AWS Lambda).
*/
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { applyVarlockConfigEnvAliases, VARLOCK_CONFIG_ENV_VAR_NAMES } from '../lib/config-env-aliases';
import { VARLOCK_CONFIG_ENV_VARS } from '../../env-graph/lib/reserved-vars';
import { encryptEnvBlobSync, generateEncryptionKeyHex } from '../crypto';

describe('applyVarlockConfigEnvAliases', () => {
  it('covers every user-settable _VARLOCK_* config var', () => {
    expect([...VARLOCK_CONFIG_ENV_VAR_NAMES].sort()).toEqual(
      VARLOCK_CONFIG_ENV_VARS.filter((v) => !v.internal).map((v) => v.name).sort(),
    );
  });

  it('copies an underscore-free alias onto the _VARLOCK_* name', () => {
    const env: Record<string, string | undefined> = { VARLOCK_ENV_KEY: 'abc', VARLOCK_USE_FROZEN_ENV: '1' };
    applyVarlockConfigEnvAliases(env);
    expect(env._VARLOCK_ENV_KEY).toBe('abc');
    expect(env._VARLOCK_USE_FROZEN_ENV).toBe('1');
  });

  it('the _VARLOCK_* name wins when both are set', () => {
    const env: Record<string, string | undefined> = { _VARLOCK_ENV_KEY: 'underscore', VARLOCK_ENV_KEY: 'alias' };
    applyVarlockConfigEnvAliases(env);
    expect(env._VARLOCK_ENV_KEY).toBe('underscore');
  });

  it('treats an empty value as unset', () => {
    const env: Record<string, string | undefined> = { _VARLOCK_ENV_KEY: '', VARLOCK_ENV_KEY: 'alias', VARLOCK_FILTER: '' };
    applyVarlockConfigEnvAliases(env);
    expect(env._VARLOCK_ENV_KEY).toBe('alias');
    expect(env._VARLOCK_FILTER).toBeUndefined();
  });

  it('leaves other VARLOCK_* vars alone', () => {
    const env: Record<string, string | undefined> = { VARLOCK_ENV: 'production', VARLOCK_DEBUG: '1' };
    applyVarlockConfigEnvAliases(env);
    expect(env).toEqual({ VARLOCK_ENV: 'production', VARLOCK_DEBUG: '1' });
  });

  it('does not throw on a read-only env', () => {
    const env = Object.freeze({ VARLOCK_ENV_KEY: 'abc' }) as Record<string, string | undefined>;
    expect(() => applyVarlockConfigEnvAliases(env)).not.toThrow();
  });
});

describe('initVarlockRuntime with VARLOCK_ENV_KEY', () => {
  const cleanup = () => {
    delete (globalThis as any).__varlockEnvState;
    delete (globalThis as any).__varlockRedactionState;
    delete (globalThis as any).__varlockLoadedEnv;
    delete process.env.__VARLOCK_ENV;
    delete process.env._VARLOCK_ENV_KEY;
    delete process.env.VARLOCK_ENV_KEY;
    delete process.env.ALIAS_TEST_VAR;
  };
  beforeEach(cleanup);
  afterEach(cleanup);

  it('decrypts an encrypted blob using only the underscore-free key name', async () => {
    const key = generateEncryptionKeyHex();
    process.env.__VARLOCK_ENV = encryptEnvBlobSync(JSON.stringify({
      sources: [],
      settings: {},
      config: { ALIAS_TEST_VAR: { value: 'decrypted-value', isSensitive: false } },
    }), key);
    process.env.VARLOCK_ENV_KEY = key;

    vi.resetModules();
    const { initVarlockRuntime } = await import('../init');
    initVarlockRuntime();
    const { ENV } = await import('../env');
    expect((ENV as any).ALIAS_TEST_VAR).toBe('decrypted-value');
  });
});
