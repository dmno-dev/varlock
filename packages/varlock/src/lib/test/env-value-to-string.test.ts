import { describe, it, expect } from 'vitest';
import { envValueToProcessEnvString, mapResolvedEnvToProcessEnv } from '../env-value-to-string';

describe('envValueToProcessEnvString', () => {
  it('maps undefined to empty string', () => {
    expect(envValueToProcessEnvString(undefined)).toBe('');
  });

  it('leaves strings unchanged', () => {
    expect(envValueToProcessEnvString('hello')).toBe('hello');
    expect(envValueToProcessEnvString('{"already":"json"}')).toBe('{"already":"json"}');
  });

  it('stringifies numbers and booleans like JSON', () => {
    expect(envValueToProcessEnvString(42)).toBe('42');
    expect(envValueToProcessEnvString(true)).toBe('true');
    expect(envValueToProcessEnvString(false)).toBe('false');
  });

  it('JSON-encodes plain objects (simple-object)', () => {
    expect(envValueToProcessEnvString({ a: 1 })).toBe('{"a":1}');
    expect(envValueToProcessEnvString({ nested: { b: true } })).toBe('{"nested":{"b":true}}');
  });

  it('JSON-encodes null and arrays', () => {
    expect(envValueToProcessEnvString(null)).toBe('null');
    expect(envValueToProcessEnvString([1, 2])).toBe('[1,2]');
  });
});

describe('mapResolvedEnvToProcessEnv', () => {
  it('stringifies each value for process/child env', () => {
    expect(mapResolvedEnvToProcessEnv({
      STR: 'hi',
      OBJ: { a: 1 },
      NUM: 7,
      UNDEF: undefined,
    })).toEqual({
      STR: 'hi',
      OBJ: '{"a":1}',
      NUM: '7',
      UNDEF: '',
    });
  });
});
