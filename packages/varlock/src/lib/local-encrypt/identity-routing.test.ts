/**
 * Payload-version routing in the orchestration layer (index.ts).
 *
 * Covers both halves of the custody rule: the file backend runs the whole v2
 * flow in TS, and a hardware backend refuses to, because unwrapping the
 * identity key here would put it in this process.
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
  delete process.env._VARLOCK_DISABLE_IDENTITY;
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env._VARLOCK_DISABLE_IDENTITY;
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

  it('still reads device-encrypted (v1) values', async () => {
    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.ensureKey();

    const ciphertext = await localEncrypt.encryptValue('legacy secret', undefined, { target: 'device' });
    expect(versionOf(ciphertext)).toBe(DEVICE_PAYLOAD_VERSION);
    expect(await localEncrypt.decryptValue(ciphertext)).toBe('legacy secret');
  });

  it('keeps writing v1 when the identity layer is switched off', async () => {
    process.env._VARLOCK_DISABLE_IDENTITY = '1';
    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.ensureKey();

    const ciphertext = await localEncrypt.encryptValue('opted out');
    expect(versionOf(ciphertext)).toBe(DEVICE_PAYLOAD_VERSION);
    expect(fs.existsSync(path.join(testDir, 'identities', 'default.json'))).toBe(false);
    expect(await localEncrypt.decryptValue(ciphertext)).toBe('opted out');
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

  it('refuses a v2 payload with a clear message instead of unwrapping in-process', async () => {
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

    const err = await hardwareBacked.decryptValue(ciphertext).then(() => undefined, (e) => e);
    expect(err).toBeInstanceOf(hardwareBacked.IdentityBackendUnsupportedError);
    expect(err.message).toMatch(/not yet supported on the \S+ backend/);
    expect(err.message).toMatch(/daemon update/);
  });

  it('keeps encrypting new values to the device key (v1)', async () => {
    const localEncrypt = await loadLocalEncrypt();
    // the native encrypt path is not exercised here; what matters is that
    // routing does not send a hardware backend down the identity path
    await expect(localEncrypt.encryptValue('secret')).rejects.toThrow('unexpected spawn in test');
    expect(fs.existsSync(path.join(testDir, 'identities', 'default.json'))).toBe(false);
  });
});
