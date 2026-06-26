import { describe, it, expect } from 'vitest';
import { serializeEnvValueForProcessEnv } from './serialize-env-value';

describe('serializeEnvValueForProcessEnv', () => {
  it('serializes arrays as JSON', () => {
    expect(serializeEnvValueForProcessEnv(['a@x.com', 'b@x.com']))
      .toBe('["a@x.com","b@x.com"]');
  });

  it('serializes plain objects as JSON', () => {
    expect(serializeEnvValueForProcessEnv({ key: 'value' }))
      .toBe('{"key":"value"}');
  });

  it('serializes primitives with String()', () => {
    expect(serializeEnvValueForProcessEnv(42)).toBe('42');
    expect(serializeEnvValueForProcessEnv(true)).toBe('true');
    expect(serializeEnvValueForProcessEnv('hello')).toBe('hello');
  });

  it('returns empty string for undefined', () => {
    expect(serializeEnvValueForProcessEnv(undefined)).toBe('');
  });
});
