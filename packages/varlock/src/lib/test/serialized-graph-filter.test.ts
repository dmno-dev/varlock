import { describe, it, expect } from 'vitest';
import { filterSerializedGraphKeys } from '../serialized-graph-filter';

const config = {
  CLOUDFLARE_API_TOKEN: { value: 't', isSensitive: true, tags: ['deploy'] },
  CLOUDFLARE_ACCOUNT_ID: { value: 'a', isSensitive: false, tags: ['deploy'] },
  BETTER_AUTH_SECRET: { value: 's', isSensitive: true },
  CORS_ORIGIN: { value: 'u', isSensitive: false, isDynamic: true },
};

describe('filterSerializedGraphKeys', () => {
  it('supports negated tags', () => {
    expect([...filterSerializedGraphKeys(config, '!#deploy')].sort()).toEqual(['BETTER_AUTH_SECRET', 'CORS_ORIGIN']);
  });
  it('supports key globs and decorators', () => {
    expect([...filterSerializedGraphKeys(config, 'CLOUDFLARE_*')].sort()).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
    expect([...filterSerializedGraphKeys(config, '@sensitive')].sort()).toEqual(['BETTER_AUTH_SECRET', 'CLOUDFLARE_API_TOKEN']);
    expect([...filterSerializedGraphKeys(config, '@dynamic,!@sensitive')]).toEqual(['CORS_ORIGIN']);
  });
  it('rejects @required, which json-full cannot answer', () => {
    expect(() => filterSerializedGraphKeys(config, '@required', 'bindingsFilter')).toThrow(/bindingsFilter: @required/);
  });
});
