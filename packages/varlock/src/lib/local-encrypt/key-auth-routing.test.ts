/**
 * How per-key `requireAuth` metadata decides where a v1 decrypt goes.
 *
 * The native helpers report a `keyDetails` array from `status`. This is the
 * matrix of what that array does, and it is a routing decision with teeth: a key
 * reported as needing no presence check stops going through the daemon at all
 * and takes the one-shot path instead, which is what makes unattended CI hosts
 * work without a session.
 *
 * The `--no-auth` row is the one that changed. Those keys used to be routed
 * through the daemon like every other key, because no helper reported the flag,
 * so nothing could tell them apart.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { FakeDaemonHarness } from './test/fake-daemon-harness';
import type { NativeKeyDetail } from './types';

let harness: FakeDaemonHarness;
let statusKeyDetails: Array<NativeKeyDetail> | undefined;
/** args of every one-shot native binary call, so the non-daemon path is visible */
let oneShotCalls: Array<Array<string>>;

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => harness.userVarlockDir,
}));

vi.mock('./binary-resolver', () => ({
  resolveNativeBinary: () => harness.binaryPath,
  getInstalledPlatformPackageName: () => undefined,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (_binary: string, args: Array<string>) => {
      if (args[0] === 'status') {
        return JSON.stringify({
          backend: 'secure-enclave',
          hardwareBacked: true,
          biometricAvailable: true,
          keys: ['gated-key', 'no-auth-key', 'every-time-key'],
          ...(statusKeyDetails ? { keyDetails: statusKeyDetails } : {}),
        });
      }
      oneShotCalls.push(args);
      return JSON.stringify({ plaintext: 'one-shot' });
    },
  };
});

async function loadLocalEncrypt() {
  vi.resetModules();
  return import('./index');
}

/** A device-encrypted (v1) payload, which is what this routing applies to */
function v1Payload(marker: string): string {
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(marker, 'utf-8')]).toString('base64');
}

beforeEach(() => {
  harness = new FakeDaemonHarness();
  harness.setConfig({ plaintexts: { [v1Payload('value')]: 'via-daemon' } });
  statusKeyDetails = undefined;
  oneShotCalls = [];
});

afterEach(() => {
  harness.cleanup();
});

describe.skipIf(process.platform === 'win32')('keyRequiresAuth', () => {
  it('defaults to true when the helper reports no keyDetails at all', async () => {
    // an older native helper, which cannot tell us either way
    statusKeyDetails = undefined;
    const localEncrypt = await loadLocalEncrypt();
    expect(localEncrypt.keyRequiresAuth('gated-key')).toBe(true);
    expect(localEncrypt.keyRequiresAuth('anything-really')).toBe(true);
  });

  it('is false for a --no-auth key', async () => {
    statusKeyDetails = [{ keyId: 'no-auth-key', requireAuth: false }];
    const localEncrypt = await loadLocalEncrypt();
    expect(localEncrypt.keyRequiresAuth('no-auth-key')).toBe(false);
  });

  it('is true for an --auth-every-time key', async () => {
    statusKeyDetails = [{ keyId: 'every-time-key', requireAuth: true }];
    const localEncrypt = await loadLocalEncrypt();
    expect(localEncrypt.keyRequiresAuth('every-time-key')).toBe(true);
  });

  it('is true for a key the helper did not mention', async () => {
    statusKeyDetails = [{ keyId: 'no-auth-key', requireAuth: false }];
    const localEncrypt = await loadLocalEncrypt();
    expect(localEncrypt.keyRequiresAuth('some-other-key')).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('where a v1 decrypt is routed', () => {
  it('goes through the daemon when the helper reports no keyDetails', async () => {
    statusKeyDetails = undefined;
    const localEncrypt = await loadLocalEncrypt();

    expect(await localEncrypt.decryptValue(v1Payload('value'), 'gated-key')).toBe('via-daemon');
    expect(harness.callsOf('decrypt')).toHaveLength(1);
    expect(oneShotCalls).toHaveLength(0);
  });

  it('goes through the daemon for a gated key', async () => {
    statusKeyDetails = [{ keyId: 'gated-key', requireAuth: true }];
    const localEncrypt = await loadLocalEncrypt();

    expect(await localEncrypt.decryptValue(v1Payload('value'), 'gated-key')).toBe('via-daemon');
    expect(harness.callsOf('decrypt')).toHaveLength(1);
    expect(oneShotCalls).toHaveLength(0);
  });

  it('takes the one-shot path for a --no-auth key, with no daemon at all', async () => {
    statusKeyDetails = [{ keyId: 'no-auth-key', requireAuth: false }];
    const localEncrypt = await loadLocalEncrypt();

    expect(await localEncrypt.decryptValue(v1Payload('value'), 'no-auth-key')).toBe('one-shot');
    expect(oneShotCalls).toHaveLength(1);
    expect(oneShotCalls[0]).toContain('decrypt');
    expect(oneShotCalls[0]).toContain('no-auth-key');
    // no session, no grant, nothing for a headless host to get stuck on
    expect(harness.calls()).toHaveLength(0);
  });

  it('routes each key on its own metadata within one process', async () => {
    statusKeyDetails = [
      { keyId: 'gated-key', requireAuth: true },
      { keyId: 'no-auth-key', requireAuth: false },
    ];
    const localEncrypt = await loadLocalEncrypt();

    await localEncrypt.decryptValue(v1Payload('value'), 'no-auth-key');
    await localEncrypt.decryptValue(v1Payload('value'), 'gated-key');

    expect(oneShotCalls).toHaveLength(1);
    expect(harness.callsOf('decrypt')).toHaveLength(1);
  });
});
