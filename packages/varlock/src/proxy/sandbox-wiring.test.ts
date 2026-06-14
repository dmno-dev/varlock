import { describe, expect, it } from 'vitest';

import {
  SANDBOX_GUEST_CA_DIR,
  buildSandboxWiring,
  formatAppleContainerRunFlags,
  parseBindAddress,
} from './sandbox-wiring';

const GUEST_CA = `${SANDBOX_GUEST_CA_DIR}/combined-ca.pem`;
import type { ProxySessionRecord } from './session-registry';

function makeSession(overrides: Partial<ProxySessionRecord> = {}): ProxySessionRecord {
  return {
    id: 'abc12',
    uuid: '00000000-0000-0000-0000-000000000000',
    ownerPid: 1234,
    cwd: '/work',
    startedAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    egressMode: 'strict',
    env: {
      HTTP_PROXY: 'http://192.168.64.1:8888',
      HTTPS_PROXY: 'http://192.168.64.1:8888',
      NODE_EXTRA_CA_CERTS: '/tmp/varlock-proxy-certs-x/ca-cert.pem',
      SSL_CERT_FILE: '/tmp/varlock-proxy-certs-x/combined-ca.pem',
      CURL_CA_BUNDLE: '/tmp/varlock-proxy-certs-x/combined-ca.pem',
    },
    placeholderOverrides: { OPENAI_API_KEY: 'vlk_placeholder_OPENAI_API_KEY_a1b2c3' },
    ...overrides,
  };
}

describe('parseBindAddress', () => {
  it('parses host:port', () => {
    expect(parseBindAddress('192.168.64.1:8888')).toEqual({ host: '192.168.64.1', port: 8888 });
  });
  it('parses host only', () => {
    expect(parseBindAddress('192.168.64.1')).toEqual({ host: '192.168.64.1' });
  });
  it('parses :port as wildcard host', () => {
    expect(parseBindAddress(':8888')).toEqual({ host: '0.0.0.0', port: 8888 });
  });
  it('treats a bare IPv6 as host only', () => {
    expect(parseBindAddress('::1')).toEqual({ host: '::1' });
  });
  it('parses bracketed IPv6 with port', () => {
    expect(parseBindAddress('[::1]:8888')).toEqual({ host: '::1', port: 8888 });
  });
  it('rejects an out-of-range port', () => {
    expect(() => parseBindAddress('host:70000')).toThrow(/port/i);
  });
  it('rejects empty input', () => {
    expect(() => parseBindAddress('   ')).toThrow();
  });
});

describe('buildSandboxWiring', () => {
  it('repoints CA paths to the in-guest mount and keeps the proxy URL', () => {
    const wiring = buildSandboxWiring(makeSession());
    expect(wiring.env.NODE_EXTRA_CA_CERTS).toBe(GUEST_CA);
    expect(wiring.env.SSL_CERT_FILE).toBe(GUEST_CA);
    expect(wiring.env.CURL_CA_BUNDLE).toBe(GUEST_CA);
    expect(wiring.env.HTTPS_PROXY).toBe('http://192.168.64.1:8888');
    // The whole certs directory is mounted (Apple `container` mounts dirs, not files).
    expect(wiring.caHostDir).toBe('/tmp/varlock-proxy-certs-x');
    expect(wiring.caGuestDir).toBe(SANDBOX_GUEST_CA_DIR);
    expect(wiring.caGuestPath).toBe(GUEST_CA);
    expect(wiring.proxyIsLoopback).toBe(false);
  });

  it('carries @proxy placeholder values into the guest env', () => {
    const wiring = buildSandboxWiring(makeSession());
    expect(wiring.env.OPENAI_API_KEY).toBe('vlk_placeholder_OPENAI_API_KEY_a1b2c3');
  });

  it('flags a loopback-bound session as unreachable from a guest', () => {
    const wiring = buildSandboxWiring(makeSession({
      env: {
        HTTPS_PROXY: 'http://127.0.0.1:51000',
        SSL_CERT_FILE: '/tmp/x/combined-ca.pem',
      },
    }));
    expect(wiring.proxyIsLoopback).toBe(true);
  });

  it('throws when no CA bundle path is present', () => {
    expect(() => buildSandboxWiring(makeSession({ env: { HTTPS_PROXY: 'http://192.168.64.1:8888' } })))
      .toThrow(/CA bundle/i);
  });
});

describe('formatAppleContainerRunFlags', () => {
  it('emits a CA mount and shell-safe -e flags', () => {
    const out = formatAppleContainerRunFlags(buildSandboxWiring(makeSession()));
    expect(out).toContain(
      `--mount type=bind,source=/tmp/varlock-proxy-certs-x,target=${SANDBOX_GUEST_CA_DIR},readonly`,
    );
    expect(out).toContain(`-e 'NODE_EXTRA_CA_CERTS=${GUEST_CA}'`);
    expect(out).toContain('-e \'HTTPS_PROXY=http://192.168.64.1:8888\'');
    expect(out).toContain('-e \'OPENAI_API_KEY=vlk_placeholder_OPENAI_API_KEY_a1b2c3\'');
  });

  it('single-quotes values that contain shell metacharacters', () => {
    const session = makeSession({
      placeholderOverrides: { BLOB: '{"a":"b c","d":"$x"}' },
    });
    const out = formatAppleContainerRunFlags(buildSandboxWiring(session));
    expect(out).toContain('-e \'BLOB={"a":"b c","d":"$x"}\'');
  });
});
