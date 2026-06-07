import { describe, expect, test } from 'vitest';
import {
  buildRunInjectedEnvBlob,
  parseRunInjectionMetadata,
  selectOverrideValuesFromEnv,
} from '../injected-env-provenance';

describe('injected env provenance', () => {
  test('builds and parses run metadata', () => {
    const blob = buildRunInjectedEnvBlob({
      serializedGraph: {
        config: {},
        settings: {},
        sources: [],
      },
      overrideKeys: ['A', 'B', 'A'],
    });

    const parsed = parseRunInjectionMetadata(blob);
    expect(parsed?.source).toBe('varlock-run');
    expect(parsed?.version).toBe(1);
    expect(parsed?.overrideKeys).toEqual(['A', 'B']);
  });

  test('returns undefined for missing metadata', () => {
    expect(parseRunInjectionMetadata(JSON.stringify({
      config: {},
      settings: {},
      sources: [],
    }))).toBeUndefined();
  });

  test('returns undefined for malformed blob', () => {
    expect(parseRunInjectionMetadata('{not-json')).toBeUndefined();
  });

  test('returns undefined for invalid metadata shape', () => {
    expect(parseRunInjectionMetadata(JSON.stringify({
      __varlockRunMeta: {
        source: 'varlock-run',
        version: 2,
        overrideKeys: ['A'],
      },
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

