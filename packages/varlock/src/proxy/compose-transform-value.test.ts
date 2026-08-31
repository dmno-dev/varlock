import { describe, expect, test } from 'vitest';
import { composeProxyTransformValue } from './types';

describe('composeProxyTransformValue', () => {
  const resolve = (name: string) => ({ TENANT: 'acme', SECRET: 's3cr3t' }[name]);
  test('composes literals and references in order', () => {
    expect(composeProxyTransformValue({ parts: ['acct-', { itemRef: 'TENANT' }, '-x'] }, resolve)).toBe('acct-acme-x');
  });
  test('a lone reference resolves to the item value', () => {
    expect(composeProxyTransformValue({ itemRef: 'SECRET' }, resolve)).toBe('s3cr3t');
  });
  test('a plain literal passes through', () => {
    expect(composeProxyTransformValue('x-oauth-basic', resolve)).toBe('x-oauth-basic');
  });
  test('an unresolvable reference contributes nothing', () => {
    expect(composeProxyTransformValue({ parts: ['a-', { itemRef: 'MISSING' }] }, resolve)).toBe('a-');
  });
});
