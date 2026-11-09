import { describe, it, expect } from 'vitest';
import { suggestClosest } from '../suggest-closest';

describe('suggestClosest', () => {
  it('finds the nearest candidate within the distance', () => {
    expect(suggestClosest('prodution', ['development', 'production'])).toBe('production');
    expect(suggestClosest('Production', ['development', 'production'])).toBe('production');
  });

  it('returns undefined when nothing is close', () => {
    expect(suggestClosest('staging', ['development', 'production'])).toBeUndefined();
  });

  it('gives up on very long input instead of computing a huge matrix', () => {
    const long = 'a'.repeat(10_000);
    expect(suggestClosest(long, [long, 'a'])).toBeUndefined();
    expect(suggestClosest('a', [long])).toBeUndefined();
  });
});
