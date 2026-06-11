import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph, DotEnvFileDataSource } from '../index';
import { isVarlockReservedKey, VARLOCK_RESERVED_KEY_PREFIX } from '../lib/builtin-vars';

describe('isVarlockReservedKey', () => {
  it('matches keys with the reserved _VARLOCK_ prefix', () => {
    expect(isVarlockReservedKey('_VARLOCK_ENV_KEY')).toBe(true);
    expect(isVarlockReservedKey('_VARLOCK_CACHE_KEY')).toBe(true);
    expect(isVarlockReservedKey('_VARLOCK_REDACT_STDOUT')).toBe(true);
    expect(isVarlockReservedKey(`${VARLOCK_RESERVED_KEY_PREFIX}ANYTHING_NEW`)).toBe(true);
  });

  it('does not match normal config keys', () => {
    expect(isVarlockReservedKey('FOO')).toBe(false);
    expect(isVarlockReservedKey('VARLOCK_ENV')).toBe(false); // no leading underscore
    expect(isVarlockReservedKey('MY__VARLOCK_THING')).toBe(false); // prefix must be at the start
  });
});

describe('serialized graph excludes reserved _VARLOCK_ keys', () => {
  async function buildSerializedConfig(envFile: string) {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: envFile }));
    await g.finishLoad();
    await g.resolveEnvValues();
    return g.getSerializedGraph().config;
  }

  it('keeps normal keys but drops any _VARLOCK_* key a user defines', async () => {
    const config = await buildSerializedConfig(outdent`
      # @defaultSensitive=false
      # ---
      FOO=bar
      _VARLOCK_ENV_KEY=should-not-leak
      _VARLOCK_REDACT_STDOUT=true
    `);

    expect(Object.keys(config)).toContain('FOO');
    expect(Object.keys(config)).not.toContain('_VARLOCK_ENV_KEY');
    expect(Object.keys(config)).not.toContain('_VARLOCK_REDACT_STDOUT');
  });
});
