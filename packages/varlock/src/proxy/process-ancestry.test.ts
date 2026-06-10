import { describe, expect, test } from 'vitest';

import { getAncestorPids } from './process-ancestry';

describe('getAncestorPids', () => {
  test('returns this process\'s ancestor chain including its direct parent', () => {
    const ancestors = getAncestorPids();
    expect(Array.isArray(ancestors)).toBe(true);
    expect(ancestors.length).toBeGreaterThan(0);
    // The first ancestor is our direct parent.
    expect(ancestors[0]).toBe(process.ppid);
    // Self is never included.
    expect(ancestors).not.toContain(process.pid);
  });

  test('walking from a given pid excludes that pid', () => {
    const ancestors = getAncestorPids(process.pid);
    expect(ancestors).not.toContain(process.pid);
    // The chain terminates (does not loop) — all entries are unique.
    expect(new Set(ancestors).size).toBe(ancestors.length);
  });

  test('returns empty for an implausible pid', () => {
    // PID 1 (init) has no real parent in our walk (parent is 0/itself).
    const ancestors = getAncestorPids(1);
    expect(ancestors).not.toContain(1);
  });
});
