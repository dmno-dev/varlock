import { describe, expect, test } from 'vitest';
import {
  normalizeOverrideKeys,
  parseBlobOverrideKeys,
  selectOverrideValuesFromEnv,
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
