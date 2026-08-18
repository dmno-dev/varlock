import {
  describe, it, expect, beforeEach,
} from 'vitest';
import { resetRedactionMap, redactSensitiveConfig } from '../env';
import type { SerializedEnvGraph } from '../../env-graph';

const SECRET_VALUE = 'super-secret-value-12345';
const REDACTED_SECRET = 'su▒▒▒▒▒';

describe('redactSensitiveConfig - plain objects and arrays (structural walk)', () => {
  beforeEach(() => {
    resetRedactionMap({
      config: {
        API_KEY: { isSensitive: true, value: SECRET_VALUE },
      },
    } as unknown as SerializedEnvGraph);
  });

  it('redacts secrets in nested object values', () => {
    const redacted = redactSensitiveConfig({ outer: { token: `key=${SECRET_VALUE}` } });
    expect(redacted.outer.token).toBe(`key=${REDACTED_SECRET}`);
  });

  it('redacts secrets in object keys', () => {
    const redacted = redactSensitiveConfig({ [SECRET_VALUE]: 'value' });
    expect(Object.keys(redacted)).toEqual([REDACTED_SECRET]);
  });

  it('does not mutate the original object', () => {
    const original = { token: SECRET_VALUE };
    redactSensitiveConfig(original);
    expect(original.token).toBe(SECRET_VALUE);
  });

  it('returns the same object when nothing is sensitive', () => {
    const clean = { a: 1, b: 'hello', nested: { c: [1, 2, 3] } };
    expect(redactSensitiveConfig(clean)).toBe(clean);
  });

  it('redacts an error nested inside a plain object, keeping message and stack', () => {
    const err = new Error(`boom ${SECRET_VALUE}`);
    const redacted = redactSensitiveConfig({ err });
    expect(redacted.err).toBeInstanceOf(Error);
    expect(redacted.err.message).toBe(`boom ${REDACTED_SECRET}`);
    expect(redacted.err.stack).toBeTruthy();
    expect(redacted.err.stack).not.toContain(SECRET_VALUE);
  });

  it('handles circular objects', () => {
    const obj: any = { token: SECRET_VALUE };
    obj.self = obj;
    const redacted = redactSensitiveConfig(obj);
    expect(redacted.token).toBe(REDACTED_SECRET);
    expect(redacted.self).toBe(redacted);
  });

  it('handles circular arrays', () => {
    const arr: Array<any> = [SECRET_VALUE];
    arr.push(arr);
    const redacted = redactSensitiveConfig(arr);
    expect(redacted[0]).toBe(REDACTED_SECRET);
    expect(redacted[1]).toBe(redacted);
  });

  it('resolves repeat references to a single copy', () => {
    const shared = { token: SECRET_VALUE };
    const redacted = redactSensitiveConfig({ a: shared, b: shared });
    expect(redacted.a.token).toBe(REDACTED_SECRET);
    expect(redacted.a).toBe(redacted.b);
  });

  it('preserves bigints alongside redacted values', () => {
    const redacted = redactSensitiveConfig({ token: SECRET_VALUE, big: 10n });
    expect(redacted.token).toBe(REDACTED_SECRET);
    expect(redacted.big).toBe(10n);
  });

  it('preserves Date instances and undefined values', () => {
    const date = new Date('2026-01-01');
    const redacted = redactSensitiveConfig({ token: SECRET_VALUE, date, missing: undefined });
    expect(redacted.date).toBe(date);
    expect('missing' in redacted).toBe(true);
    expect(redacted.missing).toBe(undefined);
  });

  it('redacts values under enumerable symbol keys', () => {
    const sym = Symbol('label');
    const redacted = redactSensitiveConfig({ [sym]: `key=${SECRET_VALUE}` });
    expect(redacted[sym]).toBe(`key=${REDACTED_SECRET}`);
  });

  it('redacts null-prototype objects, keeping the null prototype', () => {
    const obj = Object.create(null);
    obj.token = SECRET_VALUE;
    const redacted = redactSensitiveConfig(obj);
    expect(redacted.token).toBe(REDACTED_SECRET);
    expect(Object.getPrototypeOf(redacted)).toBe(null);
  });

  it('redacts arrays of objects', () => {
    const redacted = redactSensitiveConfig([{ token: SECRET_VALUE }, 'clean']);
    expect(redacted[0].token).toBe(REDACTED_SECRET);
    expect(redacted[1]).toBe('clean');
  });

  it('returns the same array when nothing is sensitive', () => {
    const clean = ['a', 'b', { c: 1 }];
    expect(redactSensitiveConfig(clean)).toBe(clean);
  });
});
