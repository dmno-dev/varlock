/**
 * Payload-version routing in the orchestration layer (index.ts).
 *
 * Covers both halves of the custody rule: the file backend runs the whole v2
 * flow in TS, and a hardware backend hands the opening to the daemon, because
 * unwrapping the identity key here would put it in this process. The daemon side
 * of that is exercised in session-decrypt.test.ts; what is pinned here is that
 * routing sends it there at all, and never down the in-process path.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEVICE_PAYLOAD_VERSION, IDENTITY_PAYLOAD_VERSION } from './crypto';

const testDir = path.join(os.tmpdir(), `varlock-identity-routing-test-${process.pid}`);

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => testDir,
}));

/** Pretend a native helper is installed, so index.ts detects a hardware backend */
let pretendNativeBinaryInstalled = false;

vi.mock('./binary-resolver', () => ({
  resolveNativeBinary: () => (pretendNativeBinaryInstalled ? '/fake/varlock-local-encrypt' : undefined),
  getInstalledPlatformPackageName: () => undefined,
}));

vi.mock('node:child_process', () => ({
  execFileSync: () => JSON.stringify({
    backend: 'secure-enclave',
    hardwareBacked: true,
    biometricAvailable: true,
    keys: ['varlock-default'],
  }),
  spawn: () => {
    throw new Error('unexpected spawn in test');
  },
  spawnSync: () => {
    throw new Error('unexpected spawnSync in test');
  },
}));

function versionOf(ciphertext: string) {
  return Buffer.from(ciphertext, 'base64')[0];
}

async function loadLocalEncrypt() {
  vi.resetModules();
  return import('./index');
}

beforeEach(() => {
  fs.mkdirSync(testDir, { recursive: true });
  pretendNativeBinaryInstalled = false;
  process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('file backend', () => {
  it('encrypts new values to the identity key (v2)', async () => {
    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.ensureKey();

    const ciphertext = await localEncrypt.encryptValue('a new secret');
    expect(versionOf(ciphertext)).toBe(IDENTITY_PAYLOAD_VERSION);
    expect(fs.existsSync(path.join(testDir, 'identities', 'default.json'))).toBe(true);
  });

  it('round-trips a v2 value', async () => {
    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.ensureKey();

    const plaintext = 'identity round trip 🔐';
    const ciphertext = await localEncrypt.encryptValue(plaintext);
    expect(await localEncrypt.decryptValue(ciphertext)).toBe(plaintext);
  });

  it('reads v2 values written by an earlier process', async () => {
    const first = await loadLocalEncrypt();
    await first.ensureKey();
    const ciphertext = await first.encryptValue('persisted secret');

    const second = await loadLocalEncrypt();
    expect(await second.decryptValue(ciphertext)).toBe('persisted secret');
  });

  it('reads and writes device-encrypted (v1) values without creating an identity', async () => {
    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.ensureKey();

    const ciphertext = await localEncrypt.encryptValue('legacy secret', undefined, { target: 'device' });
    expect(versionOf(ciphertext)).toBe(DEVICE_PAYLOAD_VERSION);
    expect(fs.existsSync(path.join(testDir, 'identities', 'default.json'))).toBe(false);
    expect(await localEncrypt.decryptValue(ciphertext)).toBe('legacy secret');
  });

  it('rejects a v3 payload as an upgrade problem', async () => {
    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.ensureKey();

    const buf = Buffer.from(await localEncrypt.encryptValue('secret'), 'base64');
    buf[0] = 0x03;

    await expect(localEncrypt.decryptValue(buf.toString('base64')))
      .rejects.toThrow('unsupported encrypted payload version 3; upgrade varlock');
  });

  it('ensureEncryptionReady creates both the device key and the identity', async () => {
    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.ensureEncryptionReady();

    expect(localEncrypt.keyExists()).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'identities', 'default.json'))).toBe(true);
  });
});

describe('hardware backend', () => {
  beforeEach(() => {
    pretendNativeBinaryInstalled = true;
    delete process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK;
  });

  it('is detected as hardware-backed', async () => {
    const localEncrypt = await loadLocalEncrypt();
    const backend = localEncrypt.getBackendInfo();
    expect(backend.type).not.toBe('file');
    expect(backend.hardwareBacked).toBe(true);
  });

  it('hands a v2 payload to the daemon rather than unwrapping it in-process', async () => {
    // build the v2 payload on the file backend, then hand it to the hardware one
    process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';
    pretendNativeBinaryInstalled = false;
    const fileBacked = await loadLocalEncrypt();
    await fileBacked.ensureKey();
    const ciphertext = await fileBacked.encryptValue('secret');
    expect(versionOf(ciphertext)).toBe(IDENTITY_PAYLOAD_VERSION);

    delete process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK;
    pretendNativeBinaryInstalled = true;
    const hardwareBacked = await loadLocalEncrypt();

    // There is no daemon here and no way to start one, so this cannot succeed.
    // Failing at the socket is the assertion: it means routing went looking for
    // the daemon rather than quietly opening the identity in this process, which
    // it could have done, since the wrap on disk is one this key could unwrap.
    const err = await hardwareBacked.decryptValue(ciphertext).then(() => undefined, (e) => e);
    expect(err).toBeDefined();
    expect(String(err.message)).toMatch(/daemon\.sock|unexpected spawn in test/);
  });

  it('encrypts new values to the identity key, with no daemon involved', async () => {
    // an identity this machine already has a wrap for, so nothing has to be
    // created; the mocked spawn throwing is what proves no native call happened
    process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';
    pretendNativeBinaryInstalled = false;
    const fileBacked = await loadLocalEncrypt();
    await fileBacked.ensureKey();
    await fileBacked.encryptValue('seed the identity');

    delete process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK;
    pretendNativeBinaryInstalled = true;
    const hardwareBacked = await loadLocalEncrypt();

    // encryption is public-key only, so a hardware backend does it right here:
    // no spawn, no daemon, no presence check
    const ciphertext = await hardwareBacked.encryptValue('secret');
    expect(versionOf(ciphertext)).toBe(IDENTITY_PAYLOAD_VERSION);
  });

  it('allows a re-encryption pass, which is what `encrypt --upgrade` checks', async () => {
    await loadLocalEncrypt();
    const { canReEncryptLocally } = await import('./re-encrypt');

    expect(canReEncryptLocally()).toEqual({ ok: true });
  });

  it('refuses to add a device wrap to an identity created elsewhere', async () => {
    // an identity file that came from another machine: it has a public key and a
    // wrap, but not one this device can open
    fs.mkdirSync(path.join(testDir, 'identities'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'identities', 'default.json'), JSON.stringify({
      version: 1,
      id: 'default',
      publicKey: Buffer.alloc(65, 4).toString('base64'),
      wraps: { 'some-other-device-key': 'AQID' },
      createdAt: new Date().toISOString(),
    }));

    const localEncrypt = await loadLocalEncrypt();
    const err = await localEncrypt.encryptValue('secret').then(() => undefined, (e) => e);

    // adding a wrap means unwrapping through a key that has one, which would put
    // the identity key in this process
    expect(err).toBeInstanceOf(localEncrypt.IdentityWrapMissingError);
    expect(err.message).toMatch(/created on another device/);
  });
});
