import { describe, expect, test } from 'vitest';

import { buildGuestEnvWiring, caDirFromSessionEnv, proxyUrlWithToken } from './guest-wiring';

describe('buildGuestEnvWiring', () => {
  const sessionProxyEnv = {
    HTTP_PROXY: 'http://127.0.0.1:51234',
    HTTPS_PROXY: 'http://127.0.0.1:51234',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    NODE_EXTRA_CA_CERTS: '/tmp/varlock-certs-abc/ca-cert.pem',
    SSL_CERT_FILE: '/tmp/varlock-certs-abc/combined-ca.pem',
    CURL_CA_BUNDLE: '/tmp/varlock-certs-abc/combined-ca.pem',
  };
  const childEnv = {
    API_TOKEN: 'vlk_placeholder_API_TOKEN_f01b',
    PUBLIC_URL: 'https://example.com',
  };

  test('repoints proxy-URL vars at the given guest proxy address', () => {
    const env = buildGuestEnvWiring({
      childEnv, sessionProxyEnv, guestProxyUrl: 'http://127.0.0.1:8888', guestCertDir: '/home/user/certs',
    });
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:8888');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:8888');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
  });

  test('repoints each CA var at its own basename under the guest cert dir', () => {
    const env = buildGuestEnvWiring({
      childEnv, sessionProxyEnv, guestProxyUrl: 'http://127.0.0.1:8888', guestCertDir: '/home/user/certs',
    });
    // Each var must keep its own file; flattening to one bundle breaks OpenSSL.
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/home/user/certs/ca-cert.pem');
    expect(env.SSL_CERT_FILE).toBe('/home/user/certs/combined-ca.pem');
    expect(env.CURL_CA_BUNDLE).toBe('/home/user/certs/combined-ca.pem');
  });

  test('carries the child-view placeholders + non-secret values verbatim', () => {
    const env = buildGuestEnvWiring({
      childEnv, sessionProxyEnv, guestProxyUrl: 'http://127.0.0.1:8888', guestCertDir: '/home/user/certs',
    });
    expect(env.API_TOKEN).toBe('vlk_placeholder_API_TOKEN_f01b');
    expect(env.PUBLIC_URL).toBe('https://example.com');
  });

  test('child view overlays the session proxy env on key collision', () => {
    const env = buildGuestEnvWiring({
      childEnv: { NO_PROXY: 'overridden' },
      sessionProxyEnv,
      guestProxyUrl: 'http://127.0.0.1:8888',
      guestCertDir: '/home/user/certs',
    });
    expect(env.NO_PROXY).toBe('overridden');
  });

  test('embeds the data-plane token into the proxy URL when present', () => {
    const env = buildGuestEnvWiring({
      childEnv, sessionProxyEnv, guestProxyUrl: 'http://10.0.0.5:8080', guestCertDir: '/certs', dataPlaneToken: 'tok-123',
    });
    expect(env.HTTPS_PROXY).toBe('http://varlock:tok-123@10.0.0.5:8080/');
    expect(env.HTTP_PROXY).toBe('http://varlock:tok-123@10.0.0.5:8080/');
  });

  test('omits credentials when no token is given', () => {
    const env = buildGuestEnvWiring({
      childEnv, sessionProxyEnv, guestProxyUrl: 'http://127.0.0.1:8888', guestCertDir: '/certs',
    });
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:8888');
  });
});

describe('proxyUrlWithToken', () => {
  test('adds basic-auth credentials with a fixed username', () => {
    expect(proxyUrlWithToken('http://host:8080', 'abc')).toBe('http://varlock:abc@host:8080/');
  });

  test('returns the url unchanged with no token', () => {
    expect(proxyUrlWithToken('http://host:8080')).toBe('http://host:8080');
  });
});

describe('caDirFromSessionEnv', () => {
  test('derives the host cert dir from whichever CA var is present', () => {
    expect(caDirFromSessionEnv({ SSL_CERT_FILE: '/tmp/varlock-certs-xyz/combined-ca.pem' }))
      .toBe('/tmp/varlock-certs-xyz');
  });

  test('throws a clear error when no CA path is present', () => {
    expect(() => caDirFromSessionEnv({ HTTPS_PROXY: 'http://127.0.0.1:1' }))
      .toThrow(/missing a CA bundle path/);
  });
});
