import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { generateGoEnvSrc } from '../../index';
import { loadFixtureFields } from './helpers';

describe('generateGoEnvSrc', () => {
  test('emits a buildable package with a struct, SensitiveKeys, and Load()', async () => {
    const { fields } = await loadFixtureFields();
    const src = generateGoEnvSrc(fields);

    // must be compilable — no build:ignore, real package
    expect(src).not.toContain('//go:build ignore');
    expect(src).toContain('package env');
    expect(src).toContain('type Env struct {');
    expect(src).not.toContain('PublicCoercedEnvSchema');
    expect(src).not.toContain('EnvAsStrings');

    // field names/types present (gofmt-aligned, so exact spacing between name and type varies)
    expect(src).toMatch(/DbHost +string/);
    expect(src).toMatch(/DbPort +\*int64/);
    expect(src).toMatch(/Debug +\*bool/);
    expect(src).toMatch(/AppEnv +string/);
    // maps are already nullable — no pointer
    expect(src).toMatch(/Config +map\[string\]any/);
    expect(src).not.toContain('*map[string]any');
    // no env: struct tags (the generated Load handles mapping)
    expect(src).not.toContain('`env:');
    // no leading blank line (gofmt strips it)
    expect(src.startsWith('//')).toBe(true);

    expect(src).toContain('var SensitiveKeys = map[string]bool{"API_KEY": true}');
    expect(src).toContain('func Load() (Env, error) {');
    // no imposed global — callers Load() once and hold/pass the value
    expect(src).not.toContain('sync.OnceValue');
    expect(src).not.toContain('"sync"');
    expect(src).toContain('os.Getenv("__VARLOCK_ENV")');
    // clear errors instead of a raw parse failure
    expect(src).toContain('__VARLOCK_ENV is not set');
    expect(src).toContain('is encrypted');
    // missing required keys are collected and reported, not silently zero-valued
    expect(src).toContain('missing required keys in __VARLOCK_ENV');
    expect(src).toContain('{"DB_HOST", &e.DbHost, true}');
    expect(src).toContain('{"DB_PORT", &e.DbPort, false}');
  });

  test('derives the package name from the output directory', async () => {
    const { fields } = await loadFixtureFields();
    expect(generateGoEnvSrc(fields, { packageName: 'config' })).toContain('package config');
    expect(generateGoEnvSrc(fields)).toContain('package env');
  });

  test('skips keys that are not valid identifiers (still tracked as sensitive)', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      OK_KEY=a       # @required @public
      MY-KEY=secret  # @required @sensitive
    `);
    const src = generateGoEnvSrc(fields);
    expect(src).toMatch(/OkKey +string/);
    // no struct field / load entry for the skipped key, but it stays in SensitiveKeys
    expect(src).not.toContain('My-key');
    expect(src).toContain('Keys omitted from this typed module (not valid identifiers): MY-KEY');
    expect(src).toContain('"MY-KEY": true');
  });
});
