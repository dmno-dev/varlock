import type * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import { expect, expectTypeOf, test } from 'vitest';

import { config } from './enums.generated.js';

test('compiles nested empty enums and string property names', () => {
  expectTypeOf<Config.Config.Success<typeof config>>().toEqualTypeOf<{
    EMPTY_ARRAY: Array<never>;
    EMPTY_VALUES: Record<string, never>;
    EMPTY_KEYS: Partial<Record<never, number>>;
    NESTED: Array<Record<string, Array<never>>>;
    BOOLEAN_KEYS: Partial<Record<'true' | 'false', number>>;
    NUMERIC_KEYS: Partial<Record<'1' | '2', number>>;
    MIXED_KEYS: Partial<Record<'true' | '1' | 'one', number>>;
    JSON_ENUM: Array<1 | '1' | true | 'true'>;
  }>();
});

test('loads empty collections and preserves mixed enum types inside JSON', () => {
  const values = {
    EMPTY_ARRAY: [],
    EMPTY_VALUES: {},
    EMPTY_KEYS: {},
    NESTED: [{ empty: [] }],
    BOOLEAN_KEYS: { true: 1, false: 2 },
    NUMERIC_KEYS: { 1: 3, 2: 4 },
    MIXED_KEYS: { true: 5, 1: 6, one: 7 },
    JSON_ENUM: [1, '1', true, 'true'],
  };
  const env = new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
  expect(Effect.runSync(config.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(env))))).toEqual(values);
});
