import {
  describe, it, expect, afterEach, vi,
} from 'vitest';
import { getCliItemFilter } from '../item-filter';
import type { ConfigItem } from '../../../env-graph/lib/config-item';

/** parse + evaluate in one step, mirroring how the commands use getCliItemFilter */
function resolveItemFilterKeys(items: Array<ConfigItem>, filterStr: string | undefined) {
  return getCliItemFilter(filterStr)?.getFilterKeys(items);
}

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

describe('getCliItemFilter', () => {
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

describe('getCliItemFilter - zero-match warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('warns on stderr when the filter matches no items', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const keys = resolveItemFilterKeys(items, '#no-such-tag');
    expect(keys).toEqual(new Set());
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--filter "#no-such-tag" matched no items'));
  });

  it('names the _VARLOCK_FILTER env var when the filter came from it', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('_VARLOCK_FILTER', '#no-such-tag');
    resolveItemFilterKeys(items, undefined);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('_VARLOCK_FILTER env var "#no-such-tag" matched no items'));
  });

  it('does not warn when the filter matches items', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveItemFilterKeys(items, '#billing');
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('getCliItemFilter - _VARLOCK_FILTER env var fallback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to _VARLOCK_FILTER when --filter is unset', () => {
    vi.stubEnv('_VARLOCK_FILTER', 'STRIPE_*');
    const keys = resolveItemFilterKeys(items, undefined);
    expect(keys).toEqual(new Set(['STRIPE_KEY', 'STRIPE_DEBUG_KEY']));
  });

  it('an explicit --filter value takes precedence over _VARLOCK_FILTER', () => {
    vi.stubEnv('_VARLOCK_FILTER', 'STRIPE_*');
    const keys = resolveItemFilterKeys(items, '#prod');
    expect(keys).toEqual(new Set(['PUBLIC_URL']));
  });

  it('no filtering when neither --filter nor _VARLOCK_FILTER is set', () => {
    vi.stubEnv('_VARLOCK_FILTER', '');
    expect(resolveItemFilterKeys(items, undefined)).toBeUndefined();
  });
});

describe('getCliItemFilter - mixed-kind selector interaction', () => {
  // deliberately overlapping in only one dimension, so a union across kinds is
  // distinguishable from an intersection
  const mixedItems = [
    makeItem('ALPHA', { isSensitive: false, tags: ['grp'] }), // tag only
    makeItem('BETA', { isSensitive: true, tags: [] }), // decorator only
    makeItem('GAMMA', { isSensitive: true, tags: ['grp'] }), // both
    makeItem('DELTA', { isSensitive: false, tags: [] }), // neither
  ];

  it('ORs a decorator selector with a tag selector, regardless of kind', () => {
    // ALPHA only matches via #grp, BETA only matches via @sensitive - both must survive,
    // proving this is a union and not an intersection of the two selectors
    const keys = resolveItemFilterKeys(mixedItems, '@sensitive,#grp');
    expect(keys).toEqual(new Set(['ALPHA', 'BETA', 'GAMMA']));
  });

  it('a negated selector subtracts from the whole pool, not just matches of its own kind', () => {
    // positive pool (by #grp) is {ALPHA, GAMMA}; the negation is a @decorator selector,
    // not a tag - it still removes GAMMA from that pool
    const keys = resolveItemFilterKeys(mixedItems, '#grp,!@sensitive');
    expect(keys).toEqual(new Set(['ALPHA']));
  });

  it('negation-only by decorator keeps everything except matches', () => {
    const keys = resolveItemFilterKeys(mixedItems, '!@sensitive');
    expect(keys).toEqual(new Set(['ALPHA', 'DELTA']));
  });

  it('negation-only by tag keeps everything except matches', () => {
    const keys = resolveItemFilterKeys(mixedItems, '!#grp');
    expect(keys).toEqual(new Set(['BETA', 'DELTA']));
  });

  it('has no way to express an intersection - only union-minus-negation', () => {
    // there is no syntax for "@sensitive AND #grp" - the closest expression is still a
    // union, so an item matching only one side (BETA) is included, not excluded
    const keys = resolveItemFilterKeys(mixedItems, '@sensitive,#grp');
    expect(keys!.has('BETA')).toBe(true); // sensitive but NOT tagged grp
    expect(keys!.has('ALPHA')).toBe(true); // tagged grp but NOT sensitive
  });
});
