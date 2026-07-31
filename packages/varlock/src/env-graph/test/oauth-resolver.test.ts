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

async function loadAndResolve(envContent: string, cacheStore?: CacheStoreLike) {
  const g = new EnvGraph();
  const source = new DotEnvFileDataSource('.env.schema', {
    overrideContents: outdent`
      # @defaultRequired=false
      # ---
      ${envContent}
    `,
  });
  await g.setRootDataSource(source);
  await g.finishLoad();
  if (cacheStore) g._cacheStore = cacheStore;
  await g.resolveEnvValues();
  return g;
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
      expect(Array.isArray(tip) ? tip.join(' ') : tip).toContain('re-provision');
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
