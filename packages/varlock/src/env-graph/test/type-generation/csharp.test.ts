import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { generateCsharpEnvSrc } from '../../index';
import { loadFixtureFields } from './helpers';

describe('generateCsharpEnvSrc', () => {
  test('emits a typed class, SensitiveKeys, and a System.Text.Json loader', async () => {
    const { fields } = await loadFixtureFields();
    const src = generateCsharpEnvSrc(fields);

    expect(src).toContain('public sealed class Env');
    expect(src).toContain('using System.Text.Json;');
    expect(src).toContain('public static readonly IReadOnlySet<string> SensitiveKeys');
    expect(src).toContain('"API_KEY"');

    expect(src).toContain('public required string DbHost { get; init; }');
    expect(src).toContain('public long? DbPort { get; init; }');
    expect(src).toContain('public bool? Debug { get; init; }');
    expect(src).toContain('public required string AppEnv { get; init; }');
    expect(src).toContain('public JsonElement Config { get; init; }');
    expect(src).toContain('public required string ApiKey { get; init; }');

    expect(src).toContain('public static Env Load()');
    expect(src).toContain('Environment.GetEnvironmentVariable("__VARLOCK_ENV")');
    expect(src).toContain('__VARLOCK_ENV is not set');
    expect(src).toContain('is encrypted');
    expect(src).toContain('missing required key DB_HOST');
    // object initializer must use Prop = Prop (bare { Prop, } is a collection initializer)
    expect(src).toContain('DbHost = DbHost,');
    // no imposed singleton
    expect(src).not.toContain('Instance');
  });

  test('supports namespace= and class= options', async () => {
    const { fields } = await loadFixtureFields();
    const src = generateCsharpEnvSrc(fields, { namespace: 'App.Config', className: 'AppEnv' });
    expect(src).toContain('namespace App.Config;');
    expect(src).toContain('public sealed class AppEnv');
    expect(src).toContain('public static AppEnv Load()');
  });

  test('rejects an invalid namespace or class name', async () => {
    const { fields } = await loadFixtureFields();
    expect(() => generateCsharpEnvSrc(fields, { className: 'Not Valid' })).toThrow(/class/);
    expect(() => generateCsharpEnvSrc(fields, { namespace: '9bad' })).toThrow(/namespace/);
  });

  test('rejects C# reserved words as class or namespace names', async () => {
    const { fields } = await loadFixtureFields();
    expect(() => generateCsharpEnvSrc(fields, { className: 'class' })).toThrow(/class/);
    expect(() => generateCsharpEnvSrc(fields, { className: 'string' })).toThrow(/class/);
    expect(() => generateCsharpEnvSrc(fields, { namespace: 'App.class' })).toThrow(/namespace/);
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
    const src = generateCsharpEnvSrc(fields);
    expect(src).toContain('public required long IntEnum { get; init; }');
    expect(src).toContain('public double? FloatEnum { get; init; }');
    expect(src).toContain('public required object MixedEnum { get; init; }');
  });

  test('skips keys that are not valid identifiers (still tracked as sensitive)', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      OK_KEY=a       # @required @public
      MY-KEY=secret  # @required @sensitive
    `);
    const src = generateCsharpEnvSrc(fields);
    expect(src).toContain('public required string OkKey { get; init; }');
    expect(src).not.toContain('My-key');
    expect(src).toContain('Keys omitted from this typed module (not valid identifiers): MY-KEY');
    expect(src).toContain('"MY-KEY"');
  });

  test('skips keys that cannot become a valid C# property name after PascalCase', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      OK_KEY=a           # @required @public
      _2FA_SECRET=s      # @required @sensitive
    `);
    const src = generateCsharpEnvSrc(fields);
    // `_2FA_SECRET` Pascal-cases to digit-leading `2faSecret`
    expect(src).not.toContain('2faSecret');
    expect(src).toContain('Keys omitted from this typed module (not valid identifiers): _2FA_SECRET');
    expect(src).toContain('"_2FA_SECRET"');
  });
});
