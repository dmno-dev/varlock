import { describe, test, expect } from 'vitest';
import { compileGlob } from '../lib/glob';

describe('key globs', () => {
  test.each([
    ['API_*', 'API_KEY', true],
    ['API_*', 'XAPI_KEY', false],
    ['*_URL', 'DB_URL', true],
    ['A?C', 'ABC', true],
    ['A?C', 'AC', false],
    ['*', '', true],
    ['', '', true],
    ['', 'A', false],
    ['A*B*C', 'AXXBYYC', true],
    ['A*B*C', 'AXXBYY', false],
    ['A.B', 'AXB', false], // regex specials are literal
    ['A.B', 'A.B', true],
    ['*', 'A*B', true],
  ])('%s against %s: %s', (pattern, key, expected) => {
    expect(compileGlob(pattern).test(key)).toBe(expected);
  });

  test('many stars against a long key do not block', () => {
    // as a regex (`^.*A.*A.*A.*A.*A.*A.*A.*B$`) this takes about 2 seconds
    const pattern = `${'*A'.repeat(7)}*B`;
    const t0 = performance.now();
    expect(compileGlob(pattern).test('A'.repeat(50))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
