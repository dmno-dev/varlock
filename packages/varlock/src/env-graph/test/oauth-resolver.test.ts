/**
 * Tests for the oauth() resolver function.
 * The token endpoint client itself is covered by src/lib/test/oauth.test.ts.
 */

import http from 'node:http';
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';
import { InMemoryCacheStore } from '../../lib/cache';
import type { CacheStoreLike } from '../../lib/cache/cache-store';
import { buildOauthProviderCacheKey, type OauthProviderCacheEntry } from '../../lib/oauth';
import { TTL_FOREVER } from '../../lib/cache/ttl-parser';

/** Minimal token endpoint that issues sequential tokens and records requests */
class MockTokenEndpoint {
  requests: Array<URLSearchParams> = [];
  /** overridable response factory - defaults to sequential tokens (index is 0-based) */
  respond: (index: number) => { status: number; body: any } = (index) => ({
    status: 200,
    body: { access_token: `at-${index}`, expires_in: 3600 },
  });

  private server?: http.Server;
  url = '';

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        this.requests.push(new URLSearchParams(raw));
        const { status, body } = this.respond(this.requests.length - 1);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server!.address() as import('node:net').AddressInfo;
    this.url = `http://127.0.0.1:${address.port}/token`;
  }

  async stop() {
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }
}

async function loadAndResolveWithHeader(headerContent: string, envContent: string, cacheStore?: CacheStoreLike) {
  const g = new EnvGraph();
  const source = new DotEnvFileDataSource('.env.schema', {
    overrideContents: outdent`
      # @defaultRequired=false
      ${headerContent}
      # ---
      ${envContent}
    `,
  });
  await g.setRootDataSource(source);
  if (cacheStore) g._cacheStore = cacheStore;
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

async function loadAndResolve(envContent: string, cacheStore?: CacheStoreLike) {
  return loadAndResolveWithHeader('', envContent, cacheStore);
}

describe('oauth()', () => {
  let endpoint: MockTokenEndpoint;
  beforeEach(async () => {
    endpoint = new MockTokenEndpoint();
    await endpoint.start();
  });
  afterEach(async () => {
    await endpoint.stop();
  });

  function refreshGrantSchema(extraArgs = '') {
    return outdent`
      # @internal @sensitive
      REFRESH_TOKEN=rt-bootstrap
      TOKEN=oauth(tokenUrl="${endpoint.url}", refreshToken=$REFRESH_TOKEN, clientId="client-1", clientSecret="secret-1"${extraArgs})
    `;
  }

  describe('resolution', () => {
    it('exchanges a refresh token for an access token', async () => {
      const g = await loadAndResolve(refreshGrantSchema());
      expect(g.configSchema.TOKEN.errors).toEqual([]);
      expect(g.configSchema.TOKEN.resolvedValue).toBe('at-0');

      const req = endpoint.requests[0];
      expect(req.get('grant_type')).toBe('refresh_token');
      expect(req.get('refresh_token')).toBe('rt-bootstrap');
      expect(req.get('client_id')).toBe('client-1');
      expect(req.get('client_secret')).toBe('secret-1');
    });

    it('is implicitly sensitive', async () => {
      const g = await loadAndResolve(refreshGrantSchema());
      expect(g.configSchema.TOKEN.isSensitive).toBe(true);
    });

    it('supports the client_credentials grant with array scopes', async () => {
      const g = await loadAndResolve(outdent`
        TOKEN=oauth(tokenUrl="${endpoint.url}", grant="client_credentials", clientId="c", clientSecret="s", scopes=["read", "write"])
      `);
      expect(g.configSchema.TOKEN.errors).toEqual([]);
      expect(g.configSchema.TOKEN.resolvedValue).toBe('at-0');
      expect(endpoint.requests[0].get('grant_type')).toBe('client_credentials');
      expect(endpoint.requests[0].get('scope')).toBe('read write');
    });

    it('passes extra params through', async () => {
      const g = await loadAndResolve(outdent`
        TOKEN=oauth(tokenUrl="${endpoint.url}", grant="client_credentials", clientId="c", clientSecret="s", params={ audience="https://api.example.com" })
      `);
      expect(g.configSchema.TOKEN.errors).toEqual([]);
      expect(endpoint.requests[0].get('audience')).toBe('https://api.example.com');
    });

    it('surfaces provider errors as resolution errors with a tip on invalid_grant', async () => {
      endpoint.respond = () => ({
        status: 400 as const,
        body: { error: 'invalid_grant', error_description: 'revoked' },
      });
      const g = await loadAndResolve(refreshGrantSchema());
      expect(g.configSchema.TOKEN.resolutionError?.message).toContain('invalid_grant');
      const tip = g.configSchema.TOKEN.resolutionError?.more?.tip;
      expect(String(tip).toLowerCase()).toContain('re-provision');
    });
  });

  describe('caching', () => {
    it('reuses a cached token across resolutions until expiry', async () => {
      const store = new InMemoryCacheStore();
      const g1 = await loadAndResolve(refreshGrantSchema(), store);
      expect(g1.configSchema.TOKEN.resolvedValue).toBe('at-0');
      expect(endpoint.requests.length).toBe(1);

      const g2 = await loadAndResolve(refreshGrantSchema(), store);
      expect(g2.configSchema.TOKEN.resolvedValue).toBe('at-0');
      expect(endpoint.requests.length).toBe(1); // no second exchange
      expect(g2.configSchema.TOKEN._cacheHits?.length).toBe(1);
    });

    it('refreshes when the cached token is within the skew window', async () => {
      // provider-reported lifetime shorter than the skew → always considered stale
      endpoint.respond = (index) => ({
        status: 200,
        body: { access_token: `at-${index}`, expires_in: 30 },
      });
      const store = new InMemoryCacheStore();
      const g1 = await loadAndResolve(refreshGrantSchema(), store);
      expect(g1.configSchema.TOKEN.resolvedValue).toBe('at-0');

      const g2 = await loadAndResolve(refreshGrantSchema(), store);
      expect(g2.configSchema.TOKEN.resolvedValue).toBe('at-1');
      expect(endpoint.requests.length).toBe(2);
    });

    it('uses the rotated refresh token on subsequent refreshes', async () => {
      endpoint.respond = (index) => ({
        status: 200,
        body: {
          access_token: `at-${index}`,
          refresh_token: `rt-rotated-${index}`,
          expires_in: 30, // always stale, forcing a refresh each resolution
        },
      });
      const store = new InMemoryCacheStore();
      await loadAndResolve(refreshGrantSchema(), store);
      expect(endpoint.requests[0].get('refresh_token')).toBe('rt-bootstrap');

      await loadAndResolve(refreshGrantSchema(), store);
      expect(endpoint.requests[1].get('refresh_token')).toBe('rt-rotated-0');
    });

    it('works without any cache store (refreshes every resolution)', async () => {
      const g1 = await loadAndResolve(refreshGrantSchema());
      const g2 = await loadAndResolve(refreshGrantSchema());
      expect(g1.configSchema.TOKEN.resolvedValue).toBe('at-0');
      expect(g2.configSchema.TOKEN.resolvedValue).toBe('at-1');
    });

    it('scopes cache entries to the configured credentials', async () => {
      const store = new InMemoryCacheStore();
      await loadAndResolve(refreshGrantSchema(), store);
      // different refresh token → different cache entry → new exchange
      await loadAndResolve(outdent`
        # @internal @sensitive
        REFRESH_TOKEN=rt-other
        TOKEN=oauth(tokenUrl="${endpoint.url}", refreshToken=$REFRESH_TOKEN, clientId="client-1", clientSecret="secret-1")
      `, store);
      expect(endpoint.requests.length).toBe(2);
    });
  });

  describe('@oauthProvider instances', () => {
    function providerHeader(extraArgs = '') {
      return `# @oauthProvider(id=test, tokenUrl="${endpoint.url}", clientId=$CLIENT_ID, clientSecret=$CLIENT_SECRET${extraArgs})`;
    }
    const clientItems = outdent`
      # @internal
      CLIENT_ID=client-1
      # @internal @sensitive
      CLIENT_SECRET=secret-1
    `;

    function seedProviderEntry(store: CacheStoreLike, refreshToken: string) {
      const key = buildOauthProviderCacheKey({ tokenUrl: endpoint.url, clientId: 'client-1' });
      const entry: OauthProviderCacheEntry = {
        refreshToken, grantedScope: 'read write', updatedAt: Date.now(), source: 'login',
      };
      return store.set(key, entry, TTL_FOREVER).then(() => key);
    }

    it('supplies client config from the provider, with explicit refreshToken', async () => {
      const g = await loadAndResolveWithHeader(providerHeader(), outdent`
        ${clientItems}
        # @internal @sensitive
        RT=rt-bootstrap
        TOKEN=oauth(test, refreshToken=$RT, scopes="read")
      `);
      expect(g.configSchema.TOKEN.errors).toEqual([]);
      expect(g.configSchema.TOKEN.resolvedValue).toBe('at-0');
      const req = endpoint.requests[0];
      expect(req.get('client_id')).toBe('client-1');
      expect(req.get('client_secret')).toBe('secret-1');
      expect(req.get('refresh_token')).toBe('rt-bootstrap');
      expect(req.get('scope')).toBe('read');
    });

    it('uses a login-provisioned refresh token from the provider cache entry', async () => {
      const store = new InMemoryCacheStore();
      await seedProviderEntry(store, 'rt-from-login');
      const g = await loadAndResolveWithHeader(providerHeader(), outdent`
        ${clientItems}
        TOKEN=oauth(test, scopes="read")
      `, store);
      expect(g.configSchema.TOKEN.errors).toEqual([]);
      expect(g.configSchema.TOKEN.resolvedValue).toBe('at-0');
      expect(endpoint.requests[0].get('refresh_token')).toBe('rt-from-login');
    });

    it('items with different scopes share the provider refresh token but cache tokens separately', async () => {
      const store = new InMemoryCacheStore();
      await seedProviderEntry(store, 'rt-from-login');
      const g = await loadAndResolveWithHeader(providerHeader(), outdent`
        ${clientItems}
        TOKEN_A=oauth(test, scopes="read")
        TOKEN_B=oauth(test, scopes="write")
      `, store);
      expect(g.configSchema.TOKEN_A.errors).toEqual([]);
      expect(g.configSchema.TOKEN_B.errors).toEqual([]);
      // two separate exchanges (different scopes), both using the shared token
      expect(endpoint.requests.length).toBe(2);
      expect(endpoint.requests[0].get('refresh_token')).toBe('rt-from-login');
      expect(endpoint.requests[1].get('refresh_token')).toBe('rt-from-login');
      expect(g.configSchema.TOKEN_A.resolvedValue).not.toBe(g.configSchema.TOKEN_B.resolvedValue);
    });

    it('stores rotated refresh tokens back into the shared provider entry', async () => {
      endpoint.respond = (index) => ({
        status: 200,
        body: {
          access_token: `at-${index}`,
          refresh_token: `rt-rotated-${index}`,
          expires_in: 30, // always stale, forcing a refresh each resolution
        },
      });
      const store = new InMemoryCacheStore();
      const providerKey = await seedProviderEntry(store, 'rt-from-login');

      await loadAndResolveWithHeader(providerHeader(), outdent`
        ${clientItems}
        TOKEN=oauth(test, scopes="read")
      `, store);
      expect(endpoint.requests[0].get('refresh_token')).toBe('rt-from-login');

      const updated = (await store.get(providerKey))?.value as OauthProviderCacheEntry;
      expect(updated.refreshToken).toBe('rt-rotated-0');
      expect(updated.source).toBe('rotation');

      // next resolution uses the rotated token
      await loadAndResolveWithHeader(providerHeader(), outdent`
        ${clientItems}
        TOKEN=oauth(test, scopes="read")
      `, store);
      expect(endpoint.requests[1].get('refresh_token')).toBe('rt-rotated-0');
    });

    it('fails with a login tip when no refresh token has been provisioned', async () => {
      const store = new InMemoryCacheStore();
      const g = await loadAndResolveWithHeader(providerHeader(), outdent`
        ${clientItems}
        TOKEN=oauth(test)
      `, store);
      expect(g.configSchema.TOKEN.resolutionError?.message).toContain('no refresh token has been provisioned');
      const tip = g.configSchema.TOKEN.resolutionError?.more?.tip;
      expect(String(tip)).toContain('varlock oauth login');
    });

    it('registers item usage on the provider record', async () => {
      const store = new InMemoryCacheStore();
      await seedProviderEntry(store, 'rt-from-login');
      const g = await loadAndResolveWithHeader(providerHeader(), outdent`
        ${clientItems}
        # @internal @sensitive
        RT=rt-own
        TOKEN_A=oauth(test, scopes="read")
        TOKEN_B=oauth(test, refreshToken=$RT)
      `, store);
      const record = g.oauthProviders.test;
      expect(record.usedBy.map((u) => u.itemKey).sort()).toEqual(['TOKEN_A', 'TOKEN_B']);
      expect(record.usedBy.find((u) => u.itemKey === 'TOKEN_A')?.hasOwnRefreshToken).toBe(false);
      expect(record.usedBy.find((u) => u.itemKey === 'TOKEN_B')?.hasOwnRefreshToken).toBe(true);
    });

    it('applies preset endpoints and clientAuth, with explicit args overriding', async () => {
      const g = await loadAndResolveWithHeader(
        // tokenUrl overrides the preset so resolution hits the mock endpoint
        `# @oauthProvider(id=goog, preset=google, tokenUrl="${endpoint.url}", clientId=$CLIENT_ID, clientSecret=$CLIENT_SECRET)`,
        outdent`
          ${clientItems}
          # @internal @sensitive
          RT=rt-1
          TOKEN=oauth(goog, refreshToken=$RT)
        `,
      );
      expect(g.configSchema.TOKEN.errors).toEqual([]);
      const record = g.oauthProviders.goog;
      expect(record.tokenUrl).toBe(endpoint.url);
      expect(record.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(record.deviceAuthorizationUrl).toBe('https://oauth2.googleapis.com/device/code');
      expect(record.extraAuthParams.access_type).toBe('offline');
    });

    it('rejects unknown provider ids, listing defined ones', async () => {
      const g = await loadAndResolveWithHeader(providerHeader(), outdent`
        ${clientItems}
        TOKEN=oauth(nope)
      `);
      expect(g.configSchema.TOKEN.errors[0]?.message).toMatch(/unknown oauth provider "nope".*test/);
    });

    it('rejects duplicate provider ids and unknown presets/args', async () => {
      const dupG = await loadAndResolveWithHeader(outdent`
        # @oauthProvider(id=test, tokenUrl="${endpoint.url}", clientId="c")
        # @oauthProvider(id=test, tokenUrl="${endpoint.url}", clientId="c")
      `, 'A=1');
      const rootErrors = dupG.rootDataSource!.schemaErrors;
      expect(rootErrors.some((e) => e.message.includes('already defined'))).toBe(true);

      const presetG = await loadAndResolveWithHeader(
        '# @oauthProvider(id=x, preset=bogus, clientId="c")',
        'A=1',
      );
      expect(presetG.rootDataSource!.schemaErrors.some((e) => e.message.includes('unknown preset'))).toBe(true);

      const argG = await loadAndResolveWithHeader(
        `# @oauthProvider(id=x, tokenUrl="${endpoint.url}", clientId="c", bogus=1)`,
        'A=1',
      );
      expect(argG.rootDataSource!.schemaErrors.some((e) => e.message.includes('unknown arg "bogus"'))).toBe(true);
    });
  });

  describe('schema validation', () => {
    async function expectSchemaError(envContent: string, messageMatch: RegExp) {
      const g = await loadAndResolve(envContent);
      const errors = g.configSchema.TOKEN.errors;
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toMatch(messageMatch);
    }

    it('requires tokenUrl', async () => {
      await expectSchemaError('TOKEN=oauth(clientId="c", refreshToken="rt")', /tokenUrl is required/);
    });

    it('requires https tokenUrl (except localhost)', async () => {
      await expectSchemaError('TOKEN=oauth(tokenUrl="http://example.com/token", clientId="c", refreshToken="rt")', /https/);
    });

    it('requires refreshToken for the refresh_token grant', async () => {
      await expectSchemaError(`TOKEN=oauth(tokenUrl="${endpoint.url}", clientId="c")`, /refreshToken is required/);
    });

    it('rejects refreshToken with the client_credentials grant', async () => {
      await expectSchemaError(
        `TOKEN=oauth(tokenUrl="${endpoint.url}", grant="client_credentials", clientId="c", refreshToken="rt")`,
        /does not apply/,
      );
    });

    it('rejects unknown grants and args', async () => {
      await expectSchemaError(`TOKEN=oauth(tokenUrl="${endpoint.url}", grant="password", clientId="c")`, /grant must be one of/);
      await expectSchemaError(`TOKEN=oauth(tokenUrl="${endpoint.url}", clientId="c", refreshToken="rt", bogus=1)`, /unknown arg "bogus"/);
    });

    it('rejects reserved keys in params', async () => {
      await expectSchemaError(
        `TOKEN=oauth(tokenUrl="${endpoint.url}", clientId="c", refreshToken="rt", params={ client_secret="x" })`,
        /reserved param/,
      );
    });

    it('cannot be wrapped in cache()', async () => {
      await expectSchemaError(
        `TOKEN=cache(oauth(tokenUrl="${endpoint.url}", clientId="c", refreshToken="rt"))`,
        /already caches/,
      );
    });
  });
});
