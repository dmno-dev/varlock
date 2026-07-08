import { describe, it, expect } from 'vitest';
import { resolveItemFilterKeys } from '../item-filter';
import type { ConfigItem } from '../../../env-graph/lib/config-item';

function makeItem(key: string, opts?: {
  isSensitive?: boolean, isRequired?: boolean, tags?: Array<string>,
}): ConfigItem {
  return {
    key,
    isSensitive: opts?.isSensitive ?? false,
    isRequired: opts?.isRequired ?? false,
    tags: opts?.tags ?? [],
  } as unknown as ConfigItem;
}

const items = [
  makeItem('STRIPE_KEY', { isSensitive: true, isRequired: true, tags: ['billing'] }),
  makeItem('STRIPE_DEBUG_KEY', { isSensitive: true, tags: ['billing', 'debug'] }),
  makeItem('PUBLIC_URL', { tags: ['prod'] }),
  makeItem('NOT_THIS', { isRequired: true }),
];

describe('resolveItemFilterKeys', () => {
  it('returns undefined when unset (no filtering)', () => {
    expect(resolveItemFilterKeys(items, undefined)).toBeUndefined();
  });

  it('selects keys by exact name', () => {
    const keys = resolveItemFilterKeys(items, 'STRIPE_KEY');
    expect(keys).toEqual(new Set(['STRIPE_KEY']));
  });

  it('selects keys by glob', () => {
    const keys = resolveItemFilterKeys(items, 'STRIPE_*');
    expect(keys).toEqual(new Set(['STRIPE_KEY', 'STRIPE_DEBUG_KEY']));
  });

  it('combines glob with a negation', () => {
    const keys = resolveItemFilterKeys(items, 'STRIPE_*,!STRIPE_DEBUG_KEY');
    expect(keys).toEqual(new Set(['STRIPE_KEY']));
  });

  it('a name plus a negation of an unrelated key still includes it', () => {
    const keys = resolveItemFilterKeys(items, 'STRIPE_KEY,!NOT_THIS');
    expect(keys).toEqual(new Set(['STRIPE_KEY']));
  });

  it('negation-only filter keeps everything except the match', () => {
    const keys = resolveItemFilterKeys(items, '!STRIPE_DEBUG_KEY');
    expect(keys).toEqual(new Set(['STRIPE_KEY', 'PUBLIC_URL', 'NOT_THIS']));
  });

  it('selects by @sensitive decorator', () => {
    const keys = resolveItemFilterKeys(items, '@sensitive');
    expect(keys).toEqual(new Set(['STRIPE_KEY', 'STRIPE_DEBUG_KEY']));
  });

  it('selects by @required decorator', () => {
    const keys = resolveItemFilterKeys(items, '@required');
    expect(keys).toEqual(new Set(['STRIPE_KEY', 'NOT_THIS']));
  });

  it('selects by #tag', () => {
    const keys = resolveItemFilterKeys(items, '#billing');
    expect(keys).toEqual(new Set(['STRIPE_KEY', 'STRIPE_DEBUG_KEY']));
  });

  it('ORs multiple positive selectors together', () => {
    const keys = resolveItemFilterKeys(items, '#prod,@required');
    expect(keys).toEqual(new Set(['PUBLIC_URL', 'STRIPE_KEY', 'NOT_THIS']));
  });

  it('trims whitespace around tokens', () => {
    const keys = resolveItemFilterKeys(items, ' STRIPE_KEY , !NOT_THIS ');
    expect(keys).toEqual(new Set(['STRIPE_KEY']));
  });

  it('throws on unknown decorator selector', () => {
    expect(() => resolveItemFilterKeys(items, '@bogus')).toThrow(/unknown decorator selector/);
  });

  it('throws on empty filter string tokens', () => {
    expect(() => resolveItemFilterKeys(items, ',,')).toThrow();
  });

  it('throws on empty tag', () => {
    expect(() => resolveItemFilterKeys(items, '#')).toThrow();
  });
});
