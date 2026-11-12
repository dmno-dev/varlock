import { describe, expect, test } from 'vitest';
import { lookupJsonKey } from '../src/json-key';

describe('lookupJsonKey', () => {
  test('reads a top-level key', () => {
    expect(lookupJsonKey({ host: 'db.example.com' }, 'host')).toEqual({ found: true, value: 'db.example.com' });
  });

  test('reads a dot-separated path into nested objects', () => {
    const parsed = { db: { host: 'db.example.com', port: 5432 } };
    expect(lookupJsonKey(parsed, 'db.host')).toEqual({ found: true, value: 'db.example.com' });
    expect(lookupJsonKey(parsed, 'db.port')).toEqual({ found: true, value: '5432' });
  });

  test('reads deeper paths', () => {
    expect(lookupJsonKey({ a: { b: { c: 'deep' } } }, 'a.b.c')).toEqual({ found: true, value: 'deep' });
  });

  test('an exact top-level key wins over a path with the same text', () => {
    const parsed = { 'db.host': 'flat', db: { host: 'nested' } };
    expect(lookupJsonKey(parsed, 'db.host')).toEqual({ found: true, value: 'flat' });
  });

  test('reports the keys at the level where the path stops', () => {
    const parsed = { db: { host: 'x', port: 1 } };
    expect(lookupJsonKey(parsed, 'db.user')).toEqual({ found: false, availableKeys: ['host', 'port'] });
    expect(lookupJsonKey(parsed, 'cache.host')).toEqual({ found: false, availableKeys: ['db'] });
  });

  test('a path through a scalar is not found', () => {
    expect(lookupJsonKey({ db: 'postgres' }, 'db.host')).toEqual({ found: false, availableKeys: [] });
  });

  test('empty path segments are not found', () => {
    expect(lookupJsonKey({ a: { b: 1 } }, 'a..b').found).toBe(false);
    expect(lookupJsonKey({ a: { b: 1 } }, 'a.').found).toBe(false);
  });

  test('inherited properties are not found', () => {
    expect(lookupJsonKey({}, 'toString').found).toBe(false);
    expect(lookupJsonKey({ db: {} }, 'db.constructor').found).toBe(false);
  });

  test('returns object and array values as JSON text', () => {
    const parsed = { db: { hosts: ['a', 'b'], opts: { ssl: true } } };
    expect(lookupJsonKey(parsed, 'db.hosts')).toEqual({ found: true, value: '["a","b"]' });
    expect(lookupJsonKey(parsed, 'db.opts')).toEqual({ found: true, value: '{"ssl":true}' });
  });

  test('keeps scalar string conversion for numbers, booleans, and null', () => {
    const parsed = { port: 5432, enabled: false, missing: null };
    expect(lookupJsonKey(parsed, 'port')).toEqual({ found: true, value: '5432' });
    expect(lookupJsonKey(parsed, 'enabled')).toEqual({ found: true, value: 'false' });
    expect(lookupJsonKey(parsed, 'missing')).toEqual({ found: true, value: 'null' });
  });

  test('reads a path that starts at an array index', () => {
    expect(lookupJsonKey([{ host: 'first' }], '0.host')).toEqual({ found: true, value: 'first' });
  });
});
