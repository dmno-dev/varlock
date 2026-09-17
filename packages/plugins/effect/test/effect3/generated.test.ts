import * as Cause from 'effect/Cause';
import type * as Config from 'effect/Config';
import * as ConfigError from 'effect/ConfigError';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import {
  describe, expect, expectTypeOf, test,
} from 'vitest';

import { config as emptyConfig, generated as empty } from './empty.generated.js';
import { config, generated } from './env.generated.js';

const env = {
  NAME: 'service',
  ENABLED: 'true',
  PORT: '3000',
  RATIO: '0.25',
  STAGE: 'dev',
  LEVEL: '2',
  HOSTS: '["localhost","example.com"]',
  MATRIX: '[[1,2],[3]]',
  LIMITS: '{"us":3}',
  FLAGS: '{"enabled":true}',
  ENTRIES: '[{"samples":[0.5,1]}]',
  DATA: '{"nested":{"values":[1,true,null]}}',
  METADATA: '{"anything":[1,"two"]}',
  SECRET_PORT: '5432',
  SECRET_STAGE: 'prod',
  SECRET_DATA: '{"password":"fixture-password"}',
};

function provider(overrides: Record<string, string | undefined> = {}) {
  const entries = Object.entries({ ...env, ...overrides })
    .filter((entry): entry is [string, string] => entry[1] !== undefined);
  return ConfigProvider.fromMap(new Map(entries));
}

function load<A, E>(effect: Effect.Effect<A, E>, overrides?: Record<string, string | undefined>) {
  return Effect.runSyncExit(effect.pipe(Effect.withConfigProvider(provider(overrides))));
}

describe('generated Effect 3 config', () => {
  test('preserves the inferred value types', () => {
    expectTypeOf(generated).toEqualTypeOf<Effect.Effect<Config.Config.Success<typeof config>>>();
    expectTypeOf<Effect.Effect.Error<typeof config>>().toEqualTypeOf<ConfigError.ConfigError>();
    expectTypeOf<Config.Config.Success<typeof config>>().toEqualTypeOf<{
      NAME: string
      ENABLED: boolean
      PORT: number
      RATIO: number
      STAGE: 'dev' | 'prod'
      LEVEL: 1 | 2
      HOSTS: Array<string>
      MATRIX: Array<Array<number>>
      LIMITS: Partial<Record<'us' | 'eu', number>>
      FLAGS: Record<string, boolean>
      ENTRIES: Array<Record<string, Array<number>>>
      DATA: Record<string, unknown>
      METADATA: Record<string, unknown>
      OPTIONAL: Option.Option<string>
      OPTIONAL_PORT: Option.Option<number>
      OPTIONAL_DATA: Option.Option<Record<string, unknown>>
      TOKEN: Option.Option<Redacted.Redacted<string>>
      SECRET_PORT: Redacted.Redacted<number>
      SECRET_STAGE: Redacted.Redacted<'dev' | 'prod'>
      SECRET_DATA: Redacted.Redacted<Record<string, unknown>>
      SECRET_HOSTS: Option.Option<Redacted.Redacted<Array<string>>>
    }>();
  });

  test('loads scalars and JSON composites through Effect.gen', () => {
    const exit = load(Effect.gen(function* loadGeneratedConfig() {
      return yield* generated;
    }));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const value = exit.value;

    expect(value).toMatchObject({
      NAME: 'service',
      ENABLED: true,
      PORT: 3000,
      RATIO: 0.25,
      STAGE: 'dev',
      LEVEL: 2,
      HOSTS: ['localhost', 'example.com'],
      MATRIX: [[1, 2], [3]],
      LIMITS: { us: 3 },
      FLAGS: { enabled: true },
      ENTRIES: [{ samples: [0.5, 1] }],
      DATA: { nested: { values: [1, true, null] } },
      METADATA: { anything: [1, 'two'] },
      OPTIONAL: Option.none(),
      OPTIONAL_PORT: Option.none(),
      OPTIONAL_DATA: Option.none(),
      TOKEN: Option.none(),
      SECRET_HOSTS: Option.none(),
    });
    expect(Redacted.value(value.SECRET_PORT)).toBe(5432);
    expect(Redacted.value(value.SECRET_STAGE)).toBe('prod');
    expect(Redacted.value(value.SECRET_DATA)).toEqual({ password: 'fixture-password' });
  });

  test('wraps present optional values and redacts sensitive values', () => {
    const value = Effect.runSync(config.pipe(Effect.withConfigProvider(provider({
      OPTIONAL: 'present',
      OPTIONAL_PORT: '8080',
      OPTIONAL_DATA: '{"present":true}',
      TOKEN: 'fixture-token',
      SECRET_HOSTS: '["private.example"]',
    }))));
    const token = Option.getOrThrow(value.TOKEN);
    const hosts = Option.getOrThrow(value.SECRET_HOSTS);

    expect(value.OPTIONAL).toEqual(Option.some('present'));
    expect(value.OPTIONAL_PORT).toEqual(Option.some(8080));
    expect(value.OPTIONAL_DATA).toEqual(Option.some({ present: true }));
    expect(Redacted.value(token)).toBe('fixture-token');
    expect(Redacted.value(hosts)).toEqual(['private.example']);
    expect(String(token)).toBe('<redacted>');
    expect(String(value.SECRET_DATA)).toBe('<redacted>');
    expect(JSON.stringify(value)).not.toMatch(/fixture-token|fixture-password|private\.example|5432|prod/);
  });

  test.each([
    ['missing sensitive enum', { SECRET_STAGE: undefined }],
    ['invalid sensitive enum', { SECRET_STAGE: 'fixture-private-stage' }],
    ['invalid sensitive integer', { SECRET_PORT: 'fixture-private-port' }],
    ['malformed sensitive JSON', { SECRET_DATA: '{"password":"fixture-password",}' }],
    ['malformed optional sensitive JSON', { SECRET_HOSTS: '["private.example",]' }],
  ] satisfies Array<[string, Record<string, string | undefined>]>)('redacts failures for %s', (_, overrides) => {
    const result = load(Effect.either(config), overrides);
    const exit = load(generated, overrides);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.isDie(exit.cause)).toBe(true);
      expect(Cause.isFailure(exit.cause)).toBe(false);
      expect(Cause.pretty(exit.cause)).toContain('<redacted>');
      expect(Cause.pretty(exit.cause)).toContain(Object.keys(overrides)[0]);
      expect(Cause.pretty(exit.cause)).not.toMatch(/dev|prod|fixture-private|fixture-password|private\.example/);
      expect(JSON.stringify(exit.cause)).not.toMatch(/dev|prod|fixture-private|fixture-password|private\.example/);
    }

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result) && result.value._tag === 'Left') {
      const failure = result.value.left;
      expect(ConfigError.isConfigError(failure)).toBe(true);
      expect(String(failure)).toContain('<redacted>');
      expect(String(failure)).toContain(Object.keys(overrides)[0]);
      expect(String(failure)).not.toMatch(/dev|prod|fixture-private|fixture-password|private\.example/);
      expect(JSON.stringify(failure)).not.toMatch(/dev|prod|fixture-private|fixture-password|private\.example/);
    } else {
      throw new Error('expected a typed config failure');
    }
  });

  test.each([
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    -10000000000000000,
    10000000000000000,
  ])('preserves the accepted integer range for %s', (input) => {
    const value = Effect.runSync(config.pipe(Effect.withConfigProvider(provider({
      PORT: String(input),
      OPTIONAL_PORT: String(input),
      SECRET_PORT: String(input),
    }))));

    expect(value.PORT).toBe(input);
    expect(value.OPTIONAL_PORT).toEqual(Option.some(input));
    expect(Redacted.value(value.SECRET_PORT)).toBe(input);
  });

  test.each([
    ['missing required string', { NAME: undefined }],
    ['missing required composite', { HOSTS: undefined }],
    ['invalid boolean', { ENABLED: 'maybe' }],
    ['fractional integer', { PORT: '3.5' }],
    ['NaN integer', { PORT: 'NaN' }],
    ['infinite integer', { PORT: 'Infinity' }],
    ['invalid number', { RATIO: 'invalid' }],
    ['invalid string enum', { STAGE: 'staging' }],
    ['invalid numeric enum', { LEVEL: '3' }],
    ['malformed JSON', { DATA: '{broken' }],
    ['malformed optional JSON', { OPTIONAL_DATA: '{broken' }],
    ['invalid optional integer', { OPTIONAL_PORT: 'invalid' }],
    ['invalid sensitive integer', { SECRET_PORT: 'invalid' }],
    ['malformed sensitive JSON', { SECRET_DATA: '{broken' }],
    ['malformed optional sensitive JSON', { SECRET_HOSTS: '{broken' }],
  ] satisfies Array<[string, Record<string, string | undefined>]>)('exposes a typed config failure and a generated defect for %s', (_, overrides) => {
    const result = load(Effect.either(config), overrides);
    const exit = load(generated, overrides);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.isDie(exit.cause)).toBe(true);
      expect(Cause.isFailure(exit.cause)).toBe(false);
      const defect = Option.getOrThrow(Cause.dieOption(exit.cause));
      expect(ConfigError.isConfigError(defect)).toBe(true);
    }

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value._tag).toBe('Left');
      if (result.value._tag === 'Left') expect(ConfigError.isConfigError(result.value.left)).toBe(true);
    }
  });

  test('preserves empty strings, unlike the Effect 4 environment provider', () => {
    const value = Effect.runSync(config.pipe(Effect.withConfigProvider(provider({
      NAME: '',
      OPTIONAL: '',
      TOKEN: '',
    }))));

    expect(value.NAME).toBe('');
    expect(value.OPTIONAL).toEqual(Option.some(''));
    expect(Redacted.value(Option.getOrThrow(value.TOKEN))).toBe('');
  });

  test('leaves composite shape validation to Varlock', () => {
    const value = Effect.runSync(config.pipe(Effect.withConfigProvider(provider({ DATA: 'null', HOSTS: '42' }))));

    expect(value.DATA).toBeNull();
    expect(value.HOSTS).toBe(42);
  });

  test('loads an empty schema', () => {
    expectTypeOf<Effect.Effect.Success<typeof empty>>().toEqualTypeOf<{}>();
    expect(Effect.runSync(empty)).toEqual({});
    expect(Effect.runSync(emptyConfig.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map()))))).toEqual({});
  });
});
