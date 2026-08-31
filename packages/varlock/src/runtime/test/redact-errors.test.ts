import {
  describe, it, expect, beforeEach,
} from 'vitest';
import { runInNewContext } from 'node:vm';
import { resetRedactionMap, redactSensitiveConfig } from '../env';
import type { SerializedEnvGraph } from '../../env-graph';

const SECRET_VALUE = 'super-secret-value-12345';
const REDACTED_SECRET = 'su▒▒▒▒▒';

/** everything an inspector could pull off an error, flattened into one string */
function inspectableString(err: any) {
  const keys = [...new Set([...Object.getOwnPropertyNames(err), 'message', 'stack'])];
  return keys.map((key) => `${key}=${String(err[key])}`).join('\n');
}

describe('redactSensitiveConfig - errors', () => {
  beforeEach(() => {
    resetRedactionMap({
      config: {
        API_KEY: { isSensitive: true, value: SECRET_VALUE },
      },
    } as unknown as SerializedEnvGraph);
  });

  it('redacts a secret in an error message', () => {
    const redacted = redactSensitiveConfig(new Error(`request failed: ${SECRET_VALUE}`));
    expect(redacted.message).toBe(`request failed: ${REDACTED_SECRET}`);
    expect(inspectableString(redacted)).not.toContain(SECRET_VALUE);
  });

  it('redacts a secret in an error stack', () => {
    const err = new Error('request failed');
    err.stack = `Error: request failed\n    at fetchThing (https://example.com/?token=${SECRET_VALUE})`;
    const redacted = redactSensitiveConfig(err);
    expect(redacted.stack).toContain(REDACTED_SECRET);
    expect(redacted.stack).not.toContain(SECRET_VALUE);
  });

  it('does not mutate the original error', () => {
    const err = new Error(`boom ${SECRET_VALUE}`);
    redactSensitiveConfig(err);
    expect(err.message).toBe(`boom ${SECRET_VALUE}`);
  });

  it('returns the same object when nothing is sensitive', () => {
    const err = new Error('nothing to hide here');
    expect(redactSensitiveConfig(err)).toBe(err);
  });

  it('keeps the copy a real error with the original prototype and name', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }
    const redacted = redactSensitiveConfig(new CustomError(`boom ${SECRET_VALUE}`));
    expect(redacted).toBeInstanceOf(CustomError);
    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.name).toBe('CustomError');
    expect(redacted.stack).toBeTruthy();
  });

  it('redacts custom properties attached to an error', () => {
    const err = Object.assign(new Error('request failed'), {
      requestUrl: `https://example.com/?token=${SECRET_VALUE}`,
      headers: { authorization: `Bearer ${SECRET_VALUE}` },
      attempts: 3,
    });
    const redacted = redactSensitiveConfig(err);
    expect(redacted.requestUrl).toBe(`https://example.com/?token=${REDACTED_SECRET}`);
    expect(redacted.headers.authorization).toBe(`Bearer ${REDACTED_SECRET}`);
    expect(redacted.attempts).toBe(3);
  });

  it('redacts secrets in custom property names and symbol descriptions', () => {
    const err: any = new Error('request failed');
    err[`token-${SECRET_VALUE}`] = 'string key';
    err[Symbol(`token-${SECRET_VALUE}`)] = 'symbol key';

    const redacted = redactSensitiveConfig(err);
    expect(Object.getOwnPropertyNames(redacted).join()).not.toContain(SECRET_VALUE);
    expect(Object.getOwnPropertySymbols(redacted).map((key) => key.description).join()).not.toContain(SECRET_VALUE);
    expect(Object.getOwnPropertyNames(err).join()).toContain(SECRET_VALUE);
  });

  it('redacts circular plain objects attached to an error', () => {
    const details: any = { token: SECRET_VALUE };
    details.self = details;
    const err: any = Object.assign(new Error('request failed'), { details });

    const redacted = redactSensitiveConfig(err);
    expect(redacted.details.token).toBe(REDACTED_SECRET);
    expect(redacted.details.self).toBe(redacted.details);
    expect(err.details.token).toBe(SECRET_VALUE);
  });

  it('recognizes cross-realm errors with a custom toStringTag', () => {
    const err = runInNewContext(`new Error('request failed: ${SECRET_VALUE}')`);
    err[Symbol.toStringTag] = 'Masked';

    const redacted = redactSensitiveConfig(err);
    expect(redacted.message).toBe(`request failed: ${REDACTED_SECRET}`);
    expect(err.message).toContain(SECRET_VALUE);
  });

  it('preserves enumerability so custom props still show up in log output', () => {
    const err = Object.assign(new Error(`boom ${SECRET_VALUE}`), { code: 'E_BOOM' });
    const redacted = redactSensitiveConfig(err);
    expect(Object.keys(redacted)).toContain('code');
    expect(Object.keys(redacted)).not.toContain('message');
    expect(Object.keys(redacted)).not.toContain('stack');
  });

  it('redacts a nested `cause` error', () => {
    const err = new Error('outer', { cause: new Error(`inner ${SECRET_VALUE}`) });
    const redacted = redactSensitiveConfig(err);
    expect(redacted.cause).toBeInstanceOf(Error);
    expect(redacted.cause.message).toBe(`inner ${REDACTED_SECRET}`);
  });

  it('redacts errors nested in arrays', () => {
    const [redacted] = redactSensitiveConfig([new Error(`boom ${SECRET_VALUE}`)]);
    expect(redacted.message).toBe(`boom ${REDACTED_SECRET}`);
  });

  it('redacts errors held in an AggregateError', () => {
    const redacted = redactSensitiveConfig(
      new AggregateError([new Error(`boom ${SECRET_VALUE}`)], 'all failed'),
    );
    expect(redacted.errors[0].message).toBe(`boom ${REDACTED_SECRET}`);
  });

  it('redacts every reference when the same error appears more than once', () => {
    const err = new Error(`boom ${SECRET_VALUE}`);
    const [first, second] = redactSensitiveConfig([err, err]);
    expect(first.message).toBe(`boom ${REDACTED_SECRET}`);
    expect(second.message).toBe(`boom ${REDACTED_SECRET}`);
  });

  it('handles a circular cause chain without hanging or leaking', () => {
    const err: any = new Error(`boom ${SECRET_VALUE}`);
    err.cause = err;
    const redacted = redactSensitiveConfig(err);
    expect(redacted.message).toBe(`boom ${REDACTED_SECRET}`);
    expect(redacted.cause).toBe(redacted);
  });

  it('skips getters that throw rather than blowing up', () => {
    const err = new Error(`boom ${SECRET_VALUE}`);
    Object.defineProperty(err, 'explode', {
      get() { throw new Error('nope'); },
      enumerable: true,
      configurable: true,
    });
    const redacted = redactSensitiveConfig(err);
    expect(redacted.message).toBe(`boom ${REDACTED_SECRET}`);
    expect('explode' in redacted).toBe(false);
  });
});
