import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { generateJavaEnvSrc } from '../../index';
import { COMPOSITE_TYPE_FIXTURE, loadFixtureFields } from './helpers';

describe('generateJavaEnvSrc', () => {
  test('emits a typed class, SENSITIVE_KEYS, and a Jackson-based loader', async () => {
    const { fields } = await loadFixtureFields();
    const src = generateJavaEnvSrc(fields);

    expect(src).toContain('public final class Env');
    expect(src).toContain('import com.fasterxml.jackson.databind.ObjectMapper;');
    expect(src).toContain('public static final Set<String> SENSITIVE_KEYS = Set.of("API_KEY");');

    expect(src).toContain('public final String dbHost;');
    expect(src).toContain('public final Long dbPort;');
    expect(src).toContain('public final Boolean debug;');
    expect(src).toContain('public final String appEnv;');
    expect(src).toContain('public final Map<String, Object> config;');
    expect(src).toContain('public final String apiKey;');

    expect(src).toContain('public static Env load()');
    expect(src).toContain('System.getenv("__VARLOCK_ENV")');
    expect(src).toContain('__VARLOCK_ENV is not set');
    expect(src).toContain('is encrypted');
    expect(src).toContain('missing required key DB_HOST');
    // Java has no throw expressions — required-missing must be an if/else statement, not a ternary
    expect(src).not.toMatch(/\? throw /);
    // no imposed singleton
    expect(src).not.toContain('INSTANCE');
  });

  test('supports package= and class= options', async () => {
    const { fields } = await loadFixtureFields();
    const src = generateJavaEnvSrc(fields, { packageName: 'com.example.config', className: 'AppEnv' });
    expect(src).toContain('package com.example.config;');
    expect(src).toContain('public final class AppEnv');
    expect(src).toContain('public static AppEnv load()');
  });

  test('rejects an invalid package or class name', async () => {
    const { fields } = await loadFixtureFields();
    expect(() => generateJavaEnvSrc(fields, { className: 'Not Valid' })).toThrow(/class/);
    expect(() => generateJavaEnvSrc(fields, { packageName: '9bad' })).toThrow(/package/);
  });

  test('rejects Java reserved words as class or package names', async () => {
    const { fields } = await loadFixtureFields();
    expect(() => generateJavaEnvSrc(fields, { className: 'class' })).toThrow(/class/);
    expect(() => generateJavaEnvSrc(fields, { packageName: 'com.int' })).toThrow(/package/);
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
    const src = generateJavaEnvSrc(fields);
    expect(src).toContain('public final long intEnum;');
    expect(src).toContain('public final Double floatEnum;');
    expect(src).toContain('public final Object mixedEnum;');
  });

  test('skips keys that are not valid identifiers (still tracked as sensitive)', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      OK_KEY=a       # @required @public
      MY-KEY=secret  # @required @sensitive
    `);
    const src = generateJavaEnvSrc(fields);
    expect(src).toContain('public final String okKey;');
    expect(src).not.toContain('my-key');
    expect(src).toContain('Keys omitted from this typed module (not valid identifiers): MY-KEY');
    expect(src).toContain('SENSITIVE_KEYS = Set.of("MY-KEY")');
  });

  test('skips keys that cannot become a valid Java field name after camelCase', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      OK_KEY=a           # @required @public
      _2FA_SECRET=s      # @required @sensitive
    `);
    const src = generateJavaEnvSrc(fields);
    // `_2FA_SECRET` camelCases to digit-leading `2faSecret`
    expect(src).not.toContain('2faSecret');
    expect(src).toContain('Keys omitted from this typed module (not valid identifiers): _2FA_SECRET');
    expect(src).toContain('"_2FA_SECRET"');
  });
  test('composite (array/object) types map to List/Map with Jackson plumbing', async () => {
    const { fields } = await loadFixtureFields(COMPOSITE_TYPE_FIXTURE);
    const src = generateJavaEnvSrc(fields);
    expect(src).toContain('public final List<Object> hosts;');
    expect(src).toContain('public final Map<String, Object> limits;');
    expect(src).toContain('import java.util.List;');
    expect(src).toContain('private static final CollectionType LIST_TYPE');
    expect(src).toContain('mapper.convertValue(hostsEntry.get("value"), LIST_TYPE)');
  });
});
