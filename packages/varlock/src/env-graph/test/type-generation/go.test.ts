import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { generateGoEnvSrc } from '../../index';
import { resolveGoPackageName } from '../../lib/type-generation/emitters/go';
import { COMPOSITE_TYPE_FIXTURE, loadFixtureFields } from './helpers';

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

  test('an explicit package= override that sanitizes to nothing is an error', () => {
    expect(() => resolveGoPackageName('env/env.go', '---'))
      .toThrow('`package` must contain at least one letter');
    // no override → fall back to the directory name
    expect(resolveGoPackageName('env/env.go')).toBe('env');
  });

  test('a package name that lands on a Go keyword is escaped (`package type` cannot compile)', () => {
    expect(resolveGoPackageName('type/env.go')).toBe('type_');
    expect(resolveGoPackageName('env/env.go', 'map')).toBe('map_');
  });

  test('skips keys that cannot become an exported field name', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      OK_KEY=a           # @required @public
      _2FA_SECRET=s      # @required @sensitive
    `);
    const src = generateGoEnvSrc(fields);
    // `_2FA_SECRET` Pascal-cases to the digit-leading `2faSecret` — not a legal Go identifier
    expect(src).not.toContain('2faSecret');
    expect(src).toContain('Keys omitted from this typed module (not valid identifiers): _2FA_SECRET');
    expect(src).toContain('"_2FA_SECRET": true');
  });

  test('numeric enums are typed by their member kind (blob carries the coerced value)', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      # @type=enum(1, 2, 3)
      INT_ENUM=2         # @required @public
      # @type=enum(0.5, 1.5)
      FLOAT_ENUM=0.5     # @optional @public
      # @type=enum(one, 2)
      MIXED_ENUM=one     # @required @public
    `);
    const src = generateGoEnvSrc(fields).replace(/ +/g, ' ');
    expect(src).toContain('IntEnum int64');
    expect(src).toContain('FloatEnum *float64');
    // mixed member kinds → `any` (already nilable, so no pointer even when optional)
    expect(src).toContain('MixedEnum any');
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
  test('composite (array/object) types map to slices and maps', async () => {
    const { fields } = await loadFixtureFields(COMPOSITE_TYPE_FIXTURE);
    const src = generateGoEnvSrc(fields);
    expect(src).toMatch(/Hosts +\[\]string/);
    // slices are already nilable — optionals get no pointer wrapping
    expect(src).toMatch(/Scores +\[\]float64/);
    expect(src).not.toContain('*[]float64');
    expect(src).toMatch(/Modes +\[\]string/);
    expect(src).toMatch(/Limits +map\[string\]float64/);
  });
});
