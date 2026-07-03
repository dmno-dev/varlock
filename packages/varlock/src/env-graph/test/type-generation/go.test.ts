import { describe, expect, test } from 'vitest';

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

    expect(src).toContain('DbHost string');
    expect(src).toContain('DbPort *int64');
    expect(src).toContain('Debug *bool');
    expect(src).toContain('AppEnv string');
    // maps are already nullable — no pointer
    expect(src).toContain('Config map[string]any');
    expect(src).not.toContain('*map[string]any');
    // no env: struct tags (the generated Load handles mapping)
    expect(src).not.toContain('`env:');

    expect(src).toContain('var SensitiveKeys = map[string]bool{"API_KEY": true}');
    expect(src).toContain('func Load() (Env, error) {');
    // no imposed global — callers Load() once and hold/pass the value
    expect(src).not.toContain('sync.OnceValue');
    expect(src).not.toContain('"sync"');
    expect(src).toContain('os.Getenv("__VARLOCK_ENV")');
  });
});
