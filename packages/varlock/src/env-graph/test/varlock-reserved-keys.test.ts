import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph, DotEnvFileDataSource } from '../index';
import {
  isVarlockReservedKey,
  mergeVarlockConfigEnv,
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
    const overrideKeys = g.getSerializedGraph().__varlockOverrideMeta?.overrideKeys ?? [];

    expect(overrideKeys).toContain('FOO');
    expect(overrideKeys).not.toContain('PATH');
    expect(overrideKeys.some((k) => k.startsWith('_VARLOCK_'))).toBe(false);
  });

  it('does not warn for normal keys', async () => {
    const g = await buildGraph(outdent`
      # @defaultSensitive=false
      # ---
      FOO=bar
    `);
    const warnings = g.sortedDataSources.flatMap((s) => s.errors).filter((e) => e.isWarning);
    expect(warnings.some((w) => w.message.includes('varlock config var'))).toBe(false);
  });
});

describe('mergeVarlockConfigEnv (single precedence rule)', () => {
  it('merges with env taking precedence over files', () => {
    const merged = mergeVarlockConfigEnv({ A: 'file-a', B: 'file-b' }, { B: 'env-b', C: 'env-c' });
    expect(merged).toEqual({ A: 'file-a', B: 'env-b', C: 'env-c' });
  });
});

describe('honoring _VARLOCK_* config vars set in .env files', () => {
  function onlyWarnings(g: EnvGraph) {
    return g.sortedDataSources.flatMap((s) => s.errors).filter((e) => e.isWarning);
  }

  // _VARLOCK_* config is only honored from .env / .env.local, so the source must be one of those
  async function buildGraph(envFile: string) {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env', { overrideContents: envFile }));
    await g.finishLoad();
    await g.resolveEnvValues();
    return g;
  }

  it('extracts a recognized static config var without warning, but keeps it out of the config', async () => {
    const g = await buildGraph(outdent`
      # @defaultSensitive=false
      # ---
      FOO=bar
      _VARLOCK_ENV_KEY=abc123
      _VARLOCK_REDACT_STDOUT=true
    `);
    expect(g.varlockConfigVarsFromFiles._VARLOCK_ENV_KEY).toBe('abc123');
    expect(g.varlockConfigVarsFromFiles._VARLOCK_REDACT_STDOUT).toBe('true');
    expect(onlyWarnings(g).some((w) => w.message.includes('_VARLOCK_'))).toBe(false);
    // still excluded from the resolved/serialized config
    expect(Object.keys(g.getSerializedGraph().config)).not.toContain('_VARLOCK_ENV_KEY');
  });

  it('lets a real env var take precedence over the .env file value', async () => {
    const g = new EnvGraph();
    g.processEnvOverride = { _VARLOCK_ENV_KEY: 'from-env' };
    await g.setRootDataSource(new DotEnvFileDataSource('.env.local', {
      overrideContents: outdent`
        # @defaultSensitive=false
        # ---
        _VARLOCK_ENV_KEY=from-file
      `,
    }));
    await g.finishLoad();
    expect(g.varlockConfigVarsFromFiles._VARLOCK_ENV_KEY).toBe('from-file');
    expect(g.varlockConfigEnv._VARLOCK_ENV_KEY).toBe('from-env');
  });

  it('errors (not just warns) and does not honor a recognized config var with a non-static value', async () => {
    // classify straight off the parsed defs — a non-static reserved value is never honored.
    // (full resolution isn't needed and isn't exercised here.)
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.local', {
      overrideContents: outdent`
        # @defaultSensitive=false
        # ---
        _VARLOCK_ENV_KEY=concat("a","b")
      `,
    }));
    g.processVarlockConfigVarsFromFiles({ emitDiagnostics: true });
    const allErrors = g.sortedDataSources.flatMap((s) => s.errors);
    const err = allErrors.find((x) => x.message.includes('_VARLOCK_ENV_KEY'));
    expect(err?.message).toContain('must be a static value');
    expect(err?.isWarning).toBeFalsy(); // a hard error, not a warning
    expect(g.varlockConfigVarsFromFiles._VARLOCK_ENV_KEY).toBeUndefined();
  });

  it('warns that an internal config var is environment-only and does not honor it', async () => {
    const g = await buildGraph(outdent`
      # @defaultSensitive=false
      # ---
      _VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK=true
    `);
    const w = onlyWarnings(g).find((x) => x.message.includes('_VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK'));
    expect(w?.message).toContain('environment only');
    expect(g.varlockConfigVarsFromFiles._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK).toBeUndefined();
  });

  it('does not honor _VARLOCK_* keys outside .env / .env.local, but warns they have no effect', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultSensitive=false
        # ---
        _VARLOCK_ENV_KEY=abc123
      `,
    }));
    await g.finishLoad();
    // not honored, and excluded from config (never a config item)
    expect(g.varlockConfigVarsFromFiles._VARLOCK_ENV_KEY).toBeUndefined();
    expect(Object.keys(g.getSerializedGraph().config)).not.toContain('_VARLOCK_ENV_KEY');
    // but the user gets a heads-up that it's in the wrong place
    const w = onlyWarnings(g).find((x) => x.message.includes('_VARLOCK_ENV_KEY'));
    expect(w?.message).toContain('has no effect in .env.schema');
  });

  it('keeps _VARLOCK_* out of the resolved env object (varlock config, not app config)', async () => {
    const g = await buildGraph(outdent`
      # @defaultSensitive=false
      # ---
      FOO=bar
      _VARLOCK_ENV_KEY=abc123
    `);
    const resolved = g.getResolvedEnvObject();
    expect(resolved).toHaveProperty('FOO');
    expect(resolved).not.toHaveProperty('_VARLOCK_ENV_KEY');
    // and it's not even a config item
    expect(g.configSchema._VARLOCK_ENV_KEY).toBeUndefined();
  });

  it('warns (non-fatally) for an unrecognized _VARLOCK_ key (likely a typo)', async () => {
    const g = await buildGraph(outdent`
      # @defaultSensitive=false
      # ---
      FOO=bar
      _VARLOCK_ENV_KYE=oops
    `);
    const w = onlyWarnings(g).find((x) => x.message.includes('_VARLOCK_ENV_KYE'));
    expect(w?.message).toContain('not a recognized varlock config var');
    expect(g.sortedDataSources.every((s) => s.isValid)).toBe(true);
  });
});
