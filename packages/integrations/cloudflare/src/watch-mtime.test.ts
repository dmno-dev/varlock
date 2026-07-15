import { describe, it, expect } from 'vitest';
import { shouldIgnoreUnchangedMtime } from './watch-mtime';

describe('shouldIgnoreUnchangedMtime', () => {
  it('ignores when both mtimes are defined and equal', () => {
    expect(shouldIgnoreUnchangedMtime(1000, 1000)).toBe(true);
  });

  it('does not ignore when mtime advanced', () => {
    expect(shouldIgnoreUnchangedMtime(1000, 1001)).toBe(false);
  });

  it('does not ignore when previous mtime is unknown', () => {
    expect(shouldIgnoreUnchangedMtime(undefined, 1000)).toBe(false);
  });

  it('does not ignore when next mtime is unknown', () => {
    expect(shouldIgnoreUnchangedMtime(1000, undefined)).toBe(false);
  });

  it('does not ignore when both mtimes are unknown', () => {
    expect(shouldIgnoreUnchangedMtime(undefined, undefined)).toBe(false);
  });
});
