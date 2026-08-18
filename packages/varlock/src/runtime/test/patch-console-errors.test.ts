/* eslint-disable no-console -- calling the patched console methods is the point here */

import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { resetRedactionMap } from '../env';
import { patchGlobalConsole } from '../patch-console';
import type { SerializedEnvGraph } from '../../env-graph';

const SECRET_VALUE = 'super-secret-value-12345';
const REDACTED_SECRET = 'su▒▒▒▒▒';

/**
 * Edge runtimes (Cloudflare Workers, Vercel Edge) have no `kWriteToConsole` internal, so
 * only the per-argument console patch applies and each argument reaches the platform
 * inspector as an object. Same story anywhere console.log was already patched by something
 * else (AWS Lambda). This stands in a bare console to exercise exactly that path.
 */
describe('patchGlobalConsole per-argument redaction (edge-style console)', () => {
  const originalConsole = globalThis.console;
  let logged: Array<Array<any>>;

  beforeEach(() => {
    logged = [];
    const record = (...args: Array<any>) => {
      logged.push(args);
    };
    const fakeConsole: any = {};
    for (const method of ['trace', 'debug', 'info', 'log', 'warn', 'error']) {
      fakeConsole[method] = record;
    }
    globalThis.console = fakeConsole;

    resetRedactionMap({
      config: { API_KEY: { isSensitive: true, value: SECRET_VALUE } },
    } as unknown as SerializedEnvGraph);
    patchGlobalConsole();
  });

  afterEach(() => {
    globalThis.console = originalConsole;
  });

  it('redacts a secret passed as a bare string', () => {
    console.log('token:', SECRET_VALUE);
    expect(logged[0]).toEqual(['token:', REDACTED_SECRET]);
  });

  it('redacts a secret inside an error message', () => {
    console.error('request failed', new Error(`boom ${SECRET_VALUE}`));
    expect(logged[0][1].message).toBe(`boom ${REDACTED_SECRET}`);
  });

  it('redacts a secret inside an error stack', () => {
    const err = new Error('request failed');
    err.stack = `Error: request failed\n    at fetchThing (https://example.com/?token=${SECRET_VALUE})`;
    console.error(err);
    expect(logged[0][0].stack).not.toContain(SECRET_VALUE);
  });

  it('redacts an error wrapped in a plain object, keeping message and stack', () => {
    const err = new Error(`boom ${SECRET_VALUE}`);
    console.error('failed', { err });
    expect(logged[0][1].err.message).toBe(`boom ${REDACTED_SECRET}`);
    expect(logged[0][1].err.stack).toBeTruthy();
    expect(logged[0][1].err.stack).not.toContain(SECRET_VALUE);
  });

  it('redacts a thrown error caught and logged directly', () => {
    try {
      throw new Error(`auth failed with ${SECRET_VALUE}`);
    } catch (err) {
      console.error(err);
    }
    expect(logged[0][0].message).toBe(`auth failed with ${REDACTED_SECRET}`);
    expect(logged[0][0]).toBeInstanceOf(Error);
  });
});
