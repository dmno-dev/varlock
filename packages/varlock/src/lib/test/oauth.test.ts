/**
 * Tests for the OAuth token endpoint client.
 * Resolver-level behavior (caching, rotation) is covered by
 * src/env-graph/test/oauth-resolver.test.ts.
 */

import http from 'node:http';
import {
  describe, it, expect, afterEach,
} from 'vitest';
import {
  assertValidTokenUrl, requestOauthToken, OauthTokenRequestError,
} from '../oauth';

type CapturedRequest = {
  headers: http.IncomingHttpHeaders;
  body: URLSearchParams;
};

/** Local stand-in for a provider token endpoint */
class MockTokenEndpoint {
  requests: Array<CapturedRequest> = [];
  respondWith: { status: number; body: string; contentType?: string } = {
    status: 200,
    body: JSON.stringify({ access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer' }),
  };

  private server?: http.Server;
  url = '';

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        this.requests.push({ headers: req.headers, body: new URLSearchParams(raw) });
        res.writeHead(this.respondWith.status, { 'content-type': this.respondWith.contentType ?? 'application/json' });
        res.end(this.respondWith.body);
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

describe('assertValidTokenUrl', () => {
  it('accepts https URLs', () => {
    expect(() => assertValidTokenUrl('https://oauth2.googleapis.com/token')).not.toThrow();
  });
  it('accepts plain http for localhost only', () => {
    expect(() => assertValidTokenUrl('http://localhost:3000/token')).not.toThrow();
    expect(() => assertValidTokenUrl('http://127.0.0.1:3000/token')).not.toThrow();
    expect(() => assertValidTokenUrl('http://example.com/token')).toThrow(/https/);
  });
  it('rejects non-http(s) and invalid URLs', () => {
    expect(() => assertValidTokenUrl('ftp://example.com/token')).toThrow();
    expect(() => assertValidTokenUrl('not a url')).toThrow();
  });
});

describe('requestOauthToken', () => {
  let endpoint: MockTokenEndpoint;
  afterEach(async () => {
    await endpoint?.stop();
  });

  async function startEndpoint() {
    endpoint = new MockTokenEndpoint();
    await endpoint.start();
  }

  it('sends a refresh_token grant with client credentials in the body', async () => {
    await startEndpoint();
    const result = await requestOauthToken({
      tokenUrl: endpoint.url,
      grantType: 'refresh_token',
      refreshToken: 'rt-1',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      scope: 'a b',
    });
    expect(result.accessToken).toBe('test-access-token');
    expect(result.expiresInSeconds).toBe(3600);
    expect(result.tokenType).toBe('Bearer');

    const req = endpoint.requests[0];
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(req.body.get('grant_type')).toBe('refresh_token');
    expect(req.body.get('refresh_token')).toBe('rt-1');
    expect(req.body.get('client_id')).toBe('client-1');
    expect(req.body.get('client_secret')).toBe('secret-1');
    expect(req.body.get('scope')).toBe('a b');
  });

  it('sends client credentials via basic auth when clientAuth=basic', async () => {
    await startEndpoint();
    await requestOauthToken({
      tokenUrl: endpoint.url,
      grantType: 'client_credentials',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      clientAuth: 'basic',
    });
    const req = endpoint.requests[0];
    const expected = Buffer.from('client-1:secret-1').toString('base64');
    expect(req.headers.authorization).toBe(`Basic ${expected}`);
    expect(req.body.get('client_id')).toBeNull();
    expect(req.body.get('client_secret')).toBeNull();
    expect(req.body.get('grant_type')).toBe('client_credentials');
  });

  it('merges extraParams into the body and rejects reserved keys', async () => {
    await startEndpoint();
    await requestOauthToken({
      tokenUrl: endpoint.url,
      grantType: 'client_credentials',
      clientId: 'client-1',
      extraParams: { audience: 'https://api.example.com' },
    });
    expect(endpoint.requests[0].body.get('audience')).toBe('https://api.example.com');

    await expect(requestOauthToken({
      tokenUrl: endpoint.url,
      grantType: 'client_credentials',
      clientId: 'client-1',
      extraParams: { grant_type: 'password' },
    })).rejects.toThrow(/reserved param/);
  });

  it('coerces a string expires_in and captures a rotated refresh token', async () => {
    await startEndpoint();
    endpoint.respondWith.body = JSON.stringify({
      access_token: 'at-2', expires_in: '1200', refresh_token: 'rt-2', scope: 'a',
    });
    const result = await requestOauthToken({
      tokenUrl: endpoint.url, grantType: 'refresh_token', refreshToken: 'rt-1', clientId: 'c',
    });
    expect(result.expiresInSeconds).toBe(1200);
    expect(result.refreshToken).toBe('rt-2');
    expect(result.scope).toBe('a');
  });

  it('maps error responses to OauthTokenRequestError with the oauth error code', async () => {
    await startEndpoint();
    endpoint.respondWith = {
      status: 400,
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been revoked' }),
    };
    const err = await requestOauthToken({
      tokenUrl: endpoint.url, grantType: 'refresh_token', refreshToken: 'rt-x', clientId: 'c',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OauthTokenRequestError);
    expect(err.details.status).toBe(400);
    expect(err.details.oauthErrorCode).toBe('invalid_grant');
    expect(err.message).toContain('invalid_grant');
    expect(err.message).toContain('Token has been revoked');
  });

  it('handles providers that return errors with HTTP 200', async () => {
    await startEndpoint();
    endpoint.respondWith.body = JSON.stringify({ ok: false, error: 'invalid_refresh_token' });
    const err = await requestOauthToken({
      tokenUrl: endpoint.url, grantType: 'refresh_token', refreshToken: 'rt-x', clientId: 'c',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OauthTokenRequestError);
    expect(err.details.oauthErrorCode).toBe('invalid_refresh_token');
  });

  it('rejects non-JSON responses', async () => {
    await startEndpoint();
    endpoint.respondWith = { status: 200, body: '<html>login page</html>', contentType: 'text/html' };
    await expect(requestOauthToken({
      tokenUrl: endpoint.url, grantType: 'client_credentials', clientId: 'c',
    })).rejects.toThrow(/non-JSON/);
  });

  it('reports connection failures without leaking secrets', async () => {
    const err = await requestOauthToken({
      // nothing is listening on this port
      tokenUrl: 'http://127.0.0.1:1/token', grantType: 'refresh_token', refreshToken: 'rt-secret', clientId: 'c',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OauthTokenRequestError);
    expect(err.message).not.toContain('rt-secret');
  });
});
