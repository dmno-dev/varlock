import { describe, test, expect } from 'vitest';
import { getWindowsPathHint } from '../lib/path-hints';

describe('getWindowsPathHint', () => {
  // these have no portable spelling, so telling the user about forward slashes would not help
  test.each([
    String.raw`C:\proj\shared\.env.schema`,
    String.raw`C:/proj/shared/.env.schema`,
    String.raw`d:\proj\.env.schema`,
    String.raw`\\server\share\.env.schema`,
  ])('flags %s as an unsupported absolute path', (declaredPath) => {
    expect(getWindowsPathHint(declaredPath)).toContain('absolute windows paths are not supported');
  });

  // these are just separators, so the user can spell them the portable way
  test.each([
    String.raw`..\..\.env.schema`,
    String.raw`.\shared\.env.schema`,
    String.raw`shared\.env.schema`,
  ])('points %s at forward slashes', (declaredPath) => {
    expect(getWindowsPathHint(declaredPath)).toContain('forward slashes');
  });

  // anything portable, or unsupported for unrelated reasons, is left to the caller's own message
  test.each([
    '../../.env.schema',
    './shared/.env.schema',
    '/abs/.env.schema',
    '~/.env.schema',
    'https://example.com/.env.schema',
    'npm:some-plugin',
    'some-plugin@1.2.3',
  ])('says nothing about %s', (declaredPath) => {
    expect(getWindowsPathHint(declaredPath)).toBeUndefined();
  });
});
