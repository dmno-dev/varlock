import { describe, expect, test } from 'vitest';
import {
  buildOverrideProvenanceMetadata,
  parseOverrideProvenanceMetadata,
  selectOverrideValuesFromEnv,
} from '../injected-env-provenance';

describe('injected env provenance', () => {
  test('builds override metadata', () => {
    const metadata = buildOverrideProvenanceMetadata(['A', 'B', 'A']);
    expect(metadata.source).toBe('varlock');
    expect(metadata.version).toBe(1);
    expect(metadata.overrideKeys).toEqual(['A', 'B']);
  });

  test('parses current metadata shape', () => {
    const parsed = parseOverrideProvenanceMetadata(JSON.stringify({
      __varlockOverrideMeta: {
        source: 'varlock',
        version: 1,
        overrideKeys: ['A', 'B', 'A'],
      },
      config: {},
      settings: {},
      sources: [],
    }));
    expect(parsed?.source).toBe('varlock');
    expect(parsed?.version).toBe(1);
    expect(parsed?.overrideKeys).toEqual(['A', 'B']);
  });

  test('parses legacy run metadata shape', () => {
    const parsed = parseOverrideProvenanceMetadata(JSON.stringify({
      __varlockRunMeta: {
        source: 'varlock-run',
        version: 1,
        overrideKeys: ['A'],
      },
      config: {},
      settings: {},
      sources: [],
    }));
    expect(parsed?.source).toBe('varlock');
    expect(parsed?.version).toBe(1);
    expect(parsed?.overrideKeys).toEqual(['A']);
  });

  test('returns undefined for malformed blob', () => {
    expect(parseOverrideProvenanceMetadata('{not-json')).toBeUndefined();
  });

  test('returns undefined for missing metadata', () => {
    expect(parseOverrideProvenanceMetadata(JSON.stringify({
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
