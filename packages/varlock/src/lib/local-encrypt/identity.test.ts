/**
 * Tests for the identity store (identity.ts).
 *
 * The device crypto is injected, so these run against a stand-in device key
 * rather than a real backend. That is the same seam `index.ts` uses.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createKeyPair, encrypt, decrypt, IDENTITY_PAYLOAD_VERSION,
} from './crypto';

const testDir = path.join(os.tmpdir(), `varlock-identity-test-${process.pid}`);

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => testDir,
}));

let identity: typeof import('./identity');

/** A device key that behaves like the file backend: real ECIES, v1 payloads */
async function makeDeviceCrypto() {
  const keys = new Map<string, { publicKey: string; privateKey: string }>();
  const decryptCalls: Array<string> = [];

  const ensure = async (keyId: string) => {
    let pair = keys.get(keyId);
    if (!pair) {
      pair = await createKeyPair();
      keys.set(keyId, pair);
    }
    return pair;
  };

  return {
    keys,
    decryptCalls,
    device: {
      async encrypt(plaintext: string, keyId: string) {
        const pair = await ensure(keyId);
        return encrypt(pair.publicKey, plaintext);
      },
      async decrypt(ciphertext: string, keyId: string) {
        decryptCalls.push(keyId);
        const pair = keys.get(keyId);
        if (!pair) throw new Error(`Key not found: ${keyId}`);
        return decrypt(pair.privateKey, pair.publicKey, ciphertext);
      },
    },
  };
}

beforeEach(async () => {
  fs.mkdirSync(testDir, { recursive: true });
  vi.resetModules();
  identity = await import('./identity');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env._VARLOCK_DISABLE_IDENTITY;
});

describe('identity store', () => {
  it('creates a default identity on first use', async () => {
    const { device } = await makeDeviceCrypto();
    expect(identity.identityExists()).toBe(false);

    const created = await identity.ensureIdentity(device, 'varlock-default');

    expect(identity.identityExists()).toBe(true);
    expect(created.id).toBe('default');
    expect(created.version).toBe(1);
    expect(created.publicKey).toBeTruthy();
    expect(Object.keys(created.wraps)).toEqual(['varlock-default']);
    expect(created.createdAt).toBeTruthy();
  });

  it('stores the identity at identities/default.json with mode 0600', async () => {
    const { device } = await makeDeviceCrypto();
    await identity.ensureIdentity(device, 'varlock-default');

    const filePath = identity.getIdentityFilePath();
    expect(filePath).toBe(path.join(testDir, 'identities', 'default.json'));

    // permission bits are the last three octal digits of the mode
    const permissions = fs.statSync(filePath).mode.toString(8).slice(-3);
    expect(permissions).toBe('600');
  });

  it('never stores the private key in the clear', async () => {
    const { device } = await makeDeviceCrypto();
    await identity.ensureIdentity(device, 'varlock-default');

    const raw = fs.readFileSync(identity.getIdentityFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.privateKey).toBeUndefined();

    // the wrap is a device-key (v1) payload, not the raw key
    const wrapBytes = Buffer.from(parsed.wraps['varlock-default'], 'base64');
    expect(wrapBytes[0]).toBe(0x01);
  });

  it('is idempotent: a second ensure reuses the same identity', async () => {
    const { device } = await makeDeviceCrypto();
    const first = await identity.ensureIdentity(device, 'varlock-default');
    const second = await identity.ensureIdentity(device, 'varlock-default');
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('round-trips wrap → unwrap → decrypt', async () => {
    const { device } = await makeDeviceCrypto();
    const plaintext = 'a secret held by the identity';

    const ciphertext = await identity.encryptToIdentity(device, plaintext, 'varlock-default');
    expect(Buffer.from(ciphertext, 'base64')[0]).toBe(IDENTITY_PAYLOAD_VERSION);

    identity.clearUnwrappedIdentityCache();
    expect(await identity.decryptWithIdentity(device, ciphertext)).toBe(plaintext);
  });

  it('reads back an identity written by a previous process', async () => {
    const { device } = await makeDeviceCrypto();
    const ciphertext = await identity.encryptToIdentity(device, 'persisted', 'varlock-default');

    // fresh module instance: nothing cached in memory
    vi.resetModules();
    const reloaded = await import('./identity');
    expect(await reloaded.decryptWithIdentity(device, ciphertext)).toBe('persisted');
  });

  it('caches the unwrapped private key so repeated decrypts hit the device once', async () => {
    const { device, decryptCalls } = await makeDeviceCrypto();
    const ct1 = await identity.encryptToIdentity(device, 'one', 'varlock-default');
    const ct2 = await identity.encryptToIdentity(device, 'two', 'varlock-default');
    identity.clearUnwrappedIdentityCache();

    expect(await identity.decryptWithIdentity(device, ct1)).toBe('one');
    expect(await identity.decryptWithIdentity(device, ct2)).toBe('two');
    expect(decryptCalls).toEqual(['varlock-default']);
  });

  it('adds a wrap for a second device key without changing the identity', async () => {
    const { device } = await makeDeviceCrypto();
    const first = await identity.ensureIdentity(device, 'varlock-default');
    const ciphertext = await identity.encryptToIdentity(device, 'shared', 'varlock-default');

    const updated = await identity.ensureIdentity(device, 'second-device');
    expect(updated.publicKey).toBe(first.publicKey);
    expect(Object.keys(updated.wraps).sort()).toEqual(['second-device', 'varlock-default']);

    // the value still opens, and it opens from the new wrap too
    identity.clearUnwrappedIdentityCache();
    expect(await identity.decryptWithIdentity(device, ciphertext)).toBe('shared');
  });

  it('fails clearly when no identity exists for a v2 payload', async () => {
    const { device } = await makeDeviceCrypto();
    const ciphertext = await identity.encryptToIdentity(device, 'secret', 'varlock-default');

    fs.rmSync(identity.getIdentityFilePath());
    identity.clearUnwrappedIdentityCache();

    await expect(identity.decryptWithIdentity(device, ciphertext))
      .rejects.toThrow(identity.IdentityNotFoundError);
  });

  it('fails clearly when no device key can unwrap the identity', async () => {
    const { device, keys } = await makeDeviceCrypto();
    const ciphertext = await identity.encryptToIdentity(device, 'secret', 'varlock-default');

    keys.delete('varlock-default');
    identity.clearUnwrappedIdentityCache();

    await expect(identity.decryptWithIdentity(device, ciphertext))
      .rejects.toThrow(/Unable to unwrap identity "default"/);
  });

  it('rejects an identity file from a newer varlock', async () => {
    const { device } = await makeDeviceCrypto();
    await identity.ensureIdentity(device, 'varlock-default');

    const filePath = identity.getIdentityFilePath();
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    stored.version = 2;
    fs.writeFileSync(filePath, JSON.stringify(stored));

    expect(() => identity.readIdentity()).toThrow('unsupported identity file version 2; upgrade varlock');
  });

  it('can be switched off with the escape-hatch env var', () => {
    expect(identity.isIdentityEnabled()).toBe(true);
    process.env._VARLOCK_DISABLE_IDENTITY = '1';
    expect(identity.isIdentityEnabled()).toBe(false);
  });
});
