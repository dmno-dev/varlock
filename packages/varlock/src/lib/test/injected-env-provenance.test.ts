import { describe, expect, test } from 'vitest';
import {
  normalizeOverrideKeys,
  parseBlobOverrideKeys,
  selectOverrideValuesFromEnv,
  selectOverridesFromInjectedEnv,
} from '../injected-env-provenance';

describe('injected env override keys', () => {
  test('normalizes (dedupes, strings only)', () => {
    expect(normalizeOverrideKeys(['A', 'B', 'A', 1 as any])).toEqual(['A', 'B']);
  });

  test('parses the plain overrideKeys field', () => {
    const parsed = parseBlobOverrideKeys(JSON.stringify({
      overrideKeys: ['A', 'B', 'A'],
      config: {},
      settings: {},
      sources: [],
    }));
    expect(parsed).toEqual(['A', 'B']);
  });

  test('still reads the list out of older wrapped shapes', () => {
    expect(parseBlobOverrideKeys(JSON.stringify({
      __varlockOverrideMeta: { source: 'varlock', version: 1, overrideKeys: ['A'] },
      config: {},
    }))).toEqual(['A']);
    expect(parseBlobOverrideKeys(JSON.stringify({
      __varlockRunMeta: { source: 'varlock-run', version: 1, overrideKeys: ['B'] },
      config: {},
    }))).toEqual(['B']);
  });

  test('returns undefined for malformed blob', () => {
    expect(parseBlobOverrideKeys('{not-json')).toBeUndefined();
    expect(parseBlobOverrideKeys('"str"')).toBeUndefined();
    expect(parseBlobOverrideKeys(JSON.stringify({ overrideKeys: 'not-an-array' }))).toBeUndefined();
  });

  test('returns undefined when no override keys are present', () => {
    expect(parseBlobOverrideKeys(JSON.stringify({
      config: {},
      settings: {},
      sources: [],
    }))).toBeUndefined();
  });

  test('selects only declared override keys from env', () => {
    const selected = selectOverrideValuesFromEnv(
      {
        A: '1',
        B: '2',
      },
      ['B', 'MISSING'],
    );

    expect(selected).toEqual({
      B: '2',
    });
  });
});

describe('selectOverridesFromInjectedEnv', () => {
  const blob = JSON.stringify({
    overrideKeys: ['RECORDED'],
    config: {
      RECORDED: { value: 'recorded-override', isSensitive: false },
      INJECTED: { value: 'injected-val', isSensitive: false },
      LIST: { value: ['a', 'b'], envStr: 'a,b', isSensitive: false },
      UNSET: { value: undefined, isSensitive: false },
    },
    settings: {},
    sources: [],
  });

  test('returns undefined without a blob or without override provenance', () => {
    expect(selectOverridesFromInjectedEnv(undefined, { A: '1' })).toBeUndefined();
    expect(selectOverridesFromInjectedEnv(JSON.stringify({ config: {} }), { A: '1' })).toBeUndefined();
  });

  test('recorded override keys are re-read from the env (changed values honored)', () => {
    expect(selectOverridesFromInjectedEnv(blob, {
      RECORDED: 'changed-later',
      INJECTED: 'injected-val',
    })).toEqual({ RECORDED: 'changed-later' });
  });

  test('unchanged parent-injected values are NOT treated as overrides', () => {
    expect(selectOverridesFromInjectedEnv(blob, {
      INJECTED: 'injected-val',
      LIST: 'a,b',
    })).toEqual({});
  });

  test('a value introduced after the parent resolved IS treated as an override', () => {
    // INJECTED was not overridden at the parent, but its ambient value no longer
    // matches what the parent injected - someone set it deliberately in between
    expect(selectOverridesFromInjectedEnv(blob, {
      INJECTED: 'introduced-later',
    })).toEqual({ INJECTED: 'introduced-later' });
  });

  test('composite values compare via their envStr form', () => {
    expect(selectOverridesFromInjectedEnv(blob, { LIST: 'a,b' })).toEqual({});
    expect(selectOverridesFromInjectedEnv(blob, { LIST: 'a,b,c' })).toEqual({ LIST: 'a,b,c' });
  });

  test('keys absent from the env are not overrides (--inject blob mode)', () => {
    expect(selectOverridesFromInjectedEnv(blob, {})).toEqual({});
  });

  test('an undefined-valued blob item set to a real value counts as introduced', () => {
    // `varlock run` drops undefined-valued keys from the child env, so presence
    // with any non-empty value means it was set after the parent resolved
    expect(selectOverridesFromInjectedEnv(blob, { UNSET: 'now-set' })).toEqual({ UNSET: 'now-set' });
  });
});
