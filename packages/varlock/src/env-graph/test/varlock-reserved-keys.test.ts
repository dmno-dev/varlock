import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph, DotEnvFileDataSource } from '../index';
import {
  isVarlockReservedKey,
  VARLOCK_RESERVED_KEY_PREFIX,
  VARLOCK_CONFIG_ENV_VARS,
  VARLOCK_INTERNAL_ENV_VARS,
} from '../lib/reserved-vars';

describe('isVarlockReservedKey', () => {
  it('matches keys with the reserved _VARLOCK_ prefix', () => {
    expect(isVarlockReservedKey('_VARLOCK_ENV_KEY')).toBe(true);
    expect(isVarlockReservedKey('_VARLOCK_CACHE_KEY')).toBe(true);
    expect(isVarlockReservedKey('_VARLOCK_REDACT_STDOUT')).toBe(true);
    expect(isVarlockReservedKey(`${VARLOCK_RESERVED_KEY_PREFIX}ANYTHING_NEW`)).toBe(true);
  });

  it('matches the underscore-free aliases of config vars', () => {
    expect(isVarlockReservedKey('VARLOCK_ENV_KEY')).toBe(true);
    expect(isVarlockReservedKey('VARLOCK_CACHE_KEY')).toBe(true);
    expect(isVarlockReservedKey('VARLOCK_USE_FROZEN_ENV')).toBe(true);
  });

  it('does not reserve computed builtins', () => {
    for (const name of ['VARLOCK_ENV', 'VARLOCK_IS_CI', 'VARLOCK_BRANCH', 'VARLOCK_PLATFORM']) {
      expect(isVarlockReservedKey(name), name).toBe(false);
    }
  });

  it('does not match normal config keys', () => {
    expect(isVarlockReservedKey('FOO')).toBe(false);
    expect(isVarlockReservedKey('VARLOCK_ENV')).toBe(false); // no leading underscore
    expect(isVarlockReservedKey('MY__VARLOCK_THING')).toBe(false); // prefix must be at the start
  });
});

describe('reserved var registry', () => {
  it('config env vars all use the single-underscore reserved prefix', () => {
    for (const v of VARLOCK_CONFIG_ENV_VARS) {
      expect(v.name.startsWith(VARLOCK_RESERVED_KEY_PREFIX), `${v.name} should start with ${VARLOCK_RESERVED_KEY_PREFIX}`).toBe(true);
      expect(v.name.startsWith('__'), `${v.name} should not be a double-underscore internal var`).toBe(false);
    }
  });

  it('internal env vars use the double-underscore prefix and are marked internal', () => {
    for (const v of VARLOCK_INTERNAL_ENV_VARS) {
      expect(v.name.startsWith('__VARLOCK_'), `${v.name} should start with __VARLOCK_`).toBe(true);
      expect(v.internal).toBe(true);
    }
  });

  it('has no duplicate names across both registries', () => {
    const names = [...VARLOCK_CONFIG_ENV_VARS, ...VARLOCK_INTERNAL_ENV_VARS].map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('serialized graph excludes reserved _VARLOCK_ keys', () => {
  async function buildGraph(envFile: string, overrideValues?: Record<string, string | undefined>) {
    const g = new EnvGraph();
    if (overrideValues) g.overrideValues = overrideValues;
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: envFile }));
    await g.finishLoad();
    await g.resolveEnvValues();
    return g;
  }

  it('keeps normal keys but drops any _VARLOCK_* key a user defines', async () => {
    const g = await buildGraph(outdent`
      # @defaultSensitive=false
      # ---
      FOO=bar
      _VARLOCK_ENV_KEY=should-not-leak
      _VARLOCK_REDACT_STDOUT=true
    `);
    const config = g.getSerializedGraph().config;

    expect(Object.keys(config)).toContain('FOO');
    expect(Object.keys(config)).not.toContain('_VARLOCK_ENV_KEY');
    expect(Object.keys(config)).not.toContain('_VARLOCK_REDACT_STDOUT');
  });

  it('drops schema-defined aliases too, even with an ambient key value', async () => {
    const g = await buildGraph(
      outdent`
        # @defaultSensitive=false @defaultRequired=false
        # ---
        FOO=bar
        VARLOCK_ENV_KEY=
        VARLOCK_CACHE_KEY=
        _VARLOCK_ENV_KEY=
      `,
      { VARLOCK_ENV_KEY: 'ambient-key', VARLOCK_CACHE_KEY: 'ambient-cache-key' },
    );
    const serialized = g.getSerializedGraph();
    expect(Object.keys(serialized.config)).toEqual(['FOO']);
    expect(JSON.stringify(serialized)).not.toContain('ambient-key');
    expect(JSON.stringify(serialized)).not.toContain('ambient-cache-key');
    expect(serialized.overrideKeys ?? []).not.toContain('VARLOCK_ENV_KEY');
  });

  it('only records schema config keys in override provenance (not arbitrary env vars or reserved keys)', async () => {
    const g = await buildGraph(
      outdent`
        # @defaultSensitive=false
        # ---
        FOO=bar
      `,
      {
        FOO: 'from-env', // matches a config item → a real override
        PATH: '/usr/bin', // arbitrary env var → must not be recorded
        _VARLOCK_REDACT_STDOUT: 'true', // reserved infra key → must not be recorded
      },
    );
    const overrideKeys = g.getSerializedGraph().overrideKeys ?? [];

    expect(overrideKeys).toContain('FOO');
    expect(overrideKeys).not.toContain('PATH');
    expect(overrideKeys.some((k) => k.startsWith('_VARLOCK_'))).toBe(false);
  });

  it('warns (non-fatally) when a user defines a reserved _VARLOCK_ key', async () => {
    const g = await buildGraph(outdent`
      # @defaultSensitive=false
      # ---
      FOO=bar
      _VARLOCK_REDACT_STDOUT=true
    `);

    const warnings = g.sortedDataSources.flatMap((s) => s.errors).filter((e) => e.isWarning);
    expect(warnings.some((w) => w.message.includes('_VARLOCK_REDACT_STDOUT'))).toBe(true);
    // a warning must not invalidate the source
    expect(g.sortedDataSources.every((s) => s.isValid)).toBe(true);
  });

  it('does not warn for normal keys', async () => {
    const g = await buildGraph(outdent`
      # @defaultSensitive=false
      # ---
      FOO=bar
    `);
    const warnings = g.sortedDataSources.flatMap((s) => s.errors).filter((e) => e.isWarning);
    expect(warnings.some((w) => w.message.includes('reserved'))).toBe(false);
  });
});
