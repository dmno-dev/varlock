import { describe, it, expect } from 'vitest';
import { InvalidEnvError, formatKeyList } from '../invalid-env-error';

describe('formatKeyList', () => {
  it('lists every key when the list is short', () => {
    expect(formatKeyList(['DATABASE_URL', 'API_TOKEN'])).toBe('DATABASE_URL, API_TOKEN');
  });

  it('caps the number of listed keys', () => {
    const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    expect(formatKeyList(keys)).toBe('A, B, C, D, E, +2 more');
  });

  it('caps the total length', () => {
    const keys = ['X'.repeat(40), 'Y'.repeat(30), 'Z'.repeat(20)];
    expect(formatKeyList(keys)).toBe(`${'X'.repeat(40)}, ${'Y'.repeat(30)}, +1 more`);
  });

  it('always lists at least one key, even a long one', () => {
    const long = 'K'.repeat(120);
    expect(formatKeyList([long, 'B'])).toBe(`${long}, +1 more`);
  });
});

describe('InvalidEnvError', () => {
  it('names the failing keys in the message and the final line', () => {
    const err = new InvalidEnvError(['DATABASE_URL', 'API_TOKEN']);
    expect(err.message).toBe('Invalid env vars: DATABASE_URL, API_TOKEN');
    expect(err.getFormattedOutput()).toContain('[varlock] Invalid env vars: DATABASE_URL, API_TOKEN');
  });

  it('falls back to a generic message with no keys', () => {
    expect(new InvalidEnvError().message).toBe('Invalid env vars');
  });
});
