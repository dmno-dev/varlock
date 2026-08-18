/**
 * Tests for the oauth login flow executors (device code + PKCE loopback).
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import {
  runDeviceCodeLogin, runPkceLogin, requestDeviceAuthorization, OauthLoginError,
} from '../oauth-login';

function base64Url(buf: Buffer) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** mock provider serving both the device-authorization and token endpoints */
class MockProvider {
  tokenRequests: Array<URLSearchParams> = [];
  deviceAuthRequests: Array<URLSearchParams> = [];

  /** how many polls return authorization_pending before success */
  pendingPolls = 0;
  /** override the successful token response body */
  tokenResponse: Record<string, any> = {
    access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'read',
  };

  private server?: http.Server;
  origin = '';
  get tokenUrl() { return `${this.origin}/token`; }
  get deviceAuthUrl() { return `${this.origin}/device`; }
  get authorizationUrl() { return `${this.origin}/authorize`; }

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        const respond = (status: number, payload: any) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.url === '/device') {
          this.deviceAuthRequests.push(body);
          respond(200, {
            device_code: 'dev-code-1',
            user_code: 'ABCD-1234',
            verification_uri: 'https://example.com/activate',
            expires_in: 300,
            interval: 0.01, // fast polling for tests
          });
        } else if (req.url === '/token') {
          this.tokenRequests.push(body);
          if (this.pendingPolls > 0) {
            this.pendingPolls -= 1;
            respond(400, { error: 'authorization_pending' });
          } else {
            respond(200, this.tokenResponse);
          }
        } else {
          respond(404, {});
        }
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server!.address() as import('node:net').AddressInfo;
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }
}

describe('oauth login flows', () => {
  let provider: MockProvider;
  beforeEach(async () => {
    provider = new MockProvider();
    await provider.start();
  });
  afterEach(async () => {
    await provider.stop();
  });

  function baseConfig() {
    return {
      tokenUrl: provider.tokenUrl,
      authorizationUrl: provider.authorizationUrl,
      deviceAuthorizationUrl: provider.deviceAuthUrl,
      clientId: 'client-1',
      clientSecret: 'secret-1',
      scope: 'read write',
    };
  }

  describe('device code flow', () => {
    it('requests a device code and polls until approved', async () => {
      provider.pendingPolls = 2;
      let shownCode: string | undefined;
      const result = await runDeviceCodeLogin(baseConfig(), {
        onUserCode: (info) => {
          shownCode = info.userCode;
        },
      });
      expect(shownCode).toBe('ABCD-1234');
      expect(result.refreshToken).toBe('rt-1');
      expect(result.grantedScope).toBe('read');
      expect(provider.deviceAuthRequests[0].get('client_id')).toBe('client-1');
      expect(provider.deviceAuthRequests[0].get('scope')).toBe('read write');
      // 2 pending + 1 success
      expect(provider.tokenRequests.length).toBe(3);
      expect(provider.tokenRequests[0].get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(provider.tokenRequests[0].get('device_code')).toBe('dev-code-1');
    });

    it('fails cleanly when the user denies access', async () => {
      // Slack-style: error returned with HTTP 200 and no access_token
      provider.tokenResponse = { error: 'access_denied' };
      await expect(runDeviceCodeLogin(baseConfig(), { onUserCode: () => undefined }))
        .rejects.toThrow(/access_denied|denied/i);
    });

    it('errors when device endpoint is missing', async () => {
      await expect(runDeviceCodeLogin(
        { ...baseConfig(), deviceAuthorizationUrl: undefined },
        { onUserCode: () => undefined },
      )).rejects.toThrow(/no device authorization endpoint/);
    });

    it('requestDeviceAuthorization surfaces provider errors with guidance', async () => {
      await provider.stop();
      await expect(requestDeviceAuthorization(baseConfig())).rejects.toThrow(OauthLoginError);
    });
  });

  describe('pkce loopback flow', () => {
    /** simulate the browser hitting the loopback callback */
    async function completeInBrowser(authUrl: string, opts?: { tamperState?: boolean; error?: string }) {
      const parsed = new URL(authUrl);
      const redirectUri = parsed.searchParams.get('redirect_uri')!;
      const state = opts?.tamperState ? 'tampered' : parsed.searchParams.get('state')!;
      const callbackUrl = new URL(redirectUri);
      if (opts?.error) {
        callbackUrl.searchParams.set('error', opts.error);
      } else {
        callbackUrl.searchParams.set('code', 'auth-code-1');
        callbackUrl.searchParams.set('state', state);
      }
      return await fetch(callbackUrl);
    }

    it('completes the full loopback exchange with PKCE', async () => {
      let capturedAuthUrl: string | undefined;
      const result = await runPkceLogin(baseConfig(), {
        onAuthorizationUrl: async (url) => {
          capturedAuthUrl = url;
          const res = await completeInBrowser(url);
          expect(res.status).toBe(200);
        },
      });
      expect(result.refreshToken).toBe('rt-1');

      const authUrl = new URL(capturedAuthUrl!);
      expect(authUrl.searchParams.get('response_type')).toBe('code');
      expect(authUrl.searchParams.get('client_id')).toBe('client-1');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');

      const exchange = provider.tokenRequests[0];
      expect(exchange.get('grant_type')).toBe('authorization_code');
      expect(exchange.get('code')).toBe('auth-code-1');
      // PKCE verifier must hash to the challenge sent in the authorization URL
      const verifier = exchange.get('code_verifier')!;
      const expectedChallenge = base64Url(createHash('sha256').update(verifier).digest());
      expect(authUrl.searchParams.get('code_challenge')).toBe(expectedChallenge);
      expect(exchange.get('redirect_uri')).toBe(authUrl.searchParams.get('redirect_uri'));
    });

    it('includes extraAuthParams in the authorization URL', async () => {
      await runPkceLogin({ ...baseConfig(), extraAuthParams: { access_type: 'offline' } }, {
        onAuthorizationUrl: async (url) => {
          expect(new URL(url).searchParams.get('access_type')).toBe('offline');
          await completeInBrowser(url);
        },
      });
    });

    it('rejects a callback with a mismatched state', async () => {
      await expect(runPkceLogin(baseConfig(), {
        onAuthorizationUrl: async (url) => {
          const res = await completeInBrowser(url, { tamperState: true });
          expect(res.status).toBe(400);
        },
      })).rejects.toThrow(/state mismatch/);
    });

    it('surfaces provider errors from the callback', async () => {
      await expect(runPkceLogin(baseConfig(), {
        onAuthorizationUrl: async (url) => {
          await completeInBrowser(url, { error: 'access_denied' });
        },
      })).rejects.toThrow(/access_denied/);
    });

    it('fails when the response has no refresh token', async () => {
      provider.tokenResponse = { access_token: 'at-1', expires_in: 3600 };
      await expect(runPkceLogin(baseConfig(), {
        onAuthorizationUrl: async (url) => {
          await completeInBrowser(url);
        },
      })).rejects.toThrow(/did not return a refresh token/);
    });
  });
});
