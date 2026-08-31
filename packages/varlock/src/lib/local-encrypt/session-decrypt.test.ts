/**
 * Opening v2 payloads on a hardware backend, end to end against a fake daemon.
 *
 * What matters here is the shape of the conversation, not the crypto: that a
 * batch costs one unlock rather than one per value, that the unlock names every
 * key and carries the display metadata, that a grant dying mid-flight is
 * retried exactly once, and that a refusal arrives as something a person can act
 * on rather than as "decryption failed".
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { FakeDaemonHarness } from './test/fake-daemon-harness';

let harness: FakeDaemonHarness;

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => harness.userVarlockDir,
}));

vi.mock('./binary-resolver', () => ({
  resolveNativeBinary: () => harness.binaryPath,
  getInstalledPlatformPackageName: () => undefined,
}));

// only the status probe is faked; spawn has to be real, because the fake daemon
// is a real process the client has to start for itself
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: () => JSON.stringify({
      backend: 'secure-enclave',
      hardwareBacked: true,
      biometricAvailable: true,
      keys: ['varlock-default', 'other-key'],
      keyDetails: [
        { keyId: 'varlock-default', requireAuth: true },
        { keyId: 'other-key', requireAuth: true },
      ],
    }),
  };
});

async function loadLocalEncrypt() {
  vi.resetModules();
  return import('./index');
}

/** A ciphertext the fake daemon will recognise, with a real v2 version byte */
function v2Payload(marker: string): string {
  return Buffer.concat([Buffer.from([0x02]), Buffer.from(marker, 'utf-8')]).toString('base64');
}

beforeEach(() => {
  harness = new FakeDaemonHarness();
  delete process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK;
});

afterEach(() => {
  harness.cleanup();
});

describe.skipIf(process.platform === 'win32')('v2 decryption through the daemon', () => {
  it('opens a whole batch with a single unlock', async () => {
    const payloads = ['alpha', 'beta', 'gamma'].map(v2Payload);
    harness.setConfig({
      plaintexts: Object.fromEntries(payloads.map((c, i) => [c, `secret-${i}`])),
    });

    const localEncrypt = await loadLocalEncrypt();
    const plaintexts = await localEncrypt.decryptIdentityPayloads(
      payloads.map((ciphertext) => ({ ciphertext, keyId: 'varlock-default' })),
    );

    expect(plaintexts).toEqual(['secret-0', 'secret-1', 'secret-2']);
    expect(harness.callsOf('unlock-session')).toHaveLength(1);
    // three values, one decrypt call: the batching is the whole point
    expect(harness.callsOf('decrypt-v2')).toHaveLength(1);
    expect(harness.callsOf('decrypt-v2')[0].payload.ciphertexts).toHaveLength(3);
  });

  it('names every key in one unlock, and sends the display metadata', async () => {
    const first = v2Payload('one');
    const second = v2Payload('two');
    harness.setConfig({ plaintexts: { [first]: 'a', [second]: 'b' } });

    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.decryptIdentityPayloads([
      { ciphertext: first, keyId: 'varlock-default' },
      { ciphertext: second, keyId: 'other-key' },
    ], { display: { projectName: 'my-project' } });

    const unlocks = harness.callsOf('unlock-session');
    expect(unlocks).toHaveLength(1);
    expect(unlocks[0].payload.keyIds).toEqual(['varlock-default', 'other-key']);
    expect(unlocks[0].payload.scope).toBe('session');

    const display = unlocks[0].payload.display as Record<string, unknown>;
    expect(display.projectName).toBe('my-project');
    expect(display.itemCounts).toEqual({ 'varlock-default': 1, 'other-key': 1 });

    // one decrypt per key, since a grant is per (session x key)
    expect(harness.callsOf('decrypt-v2')).toHaveLength(2);
  });

  it('tells the panel which values, in which files, each key is being asked for', async () => {
    const dbUrl = v2Payload('db');
    const stripe = v2Payload('stripe');
    const localOnly = v2Payload('local');
    const prodKey = v2Payload('prod');
    harness.setConfig({
      plaintexts: {
        [dbUrl]: 'a', [stripe]: 'b', [localOnly]: 'c', [prodKey]: 'd',
      },
    });

    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.decryptIdentityPayloads([
      {
        ciphertext: dbUrl, keyId: 'varlock-default', valueName: 'DATABASE_URL', sourceFile: '.env',
      },
      {
        ciphertext: stripe, keyId: 'varlock-default', valueName: 'STRIPE_KEY', sourceFile: '.env',
      },
      {
        ciphertext: localOnly, keyId: 'varlock-default', valueName: 'NGROK_TOKEN', sourceFile: '.env.local',
      },
      {
        ciphertext: prodKey, keyId: 'other-key', valueName: 'PROD_TOKEN', sourceFile: '.env.prod',
      },
    ], { display: { projectName: 'acme-api' } });

    const display = harness.callsOf('unlock-session')[0].payload.display as any;
    expect(display.projectName).toBe('acme-api');
    expect(display.keys['varlock-default'].valueCount).toBe(3);
    // grouped by the file that defined them, in the order the files first appear
    expect(display.keys['varlock-default'].files).toEqual([
      { path: '.env', valueNames: ['DATABASE_URL', 'STRIPE_KEY'] },
      { path: '.env.local', valueNames: ['NGROK_TOKEN'] },
    ]);
    expect(display.keys['other-key']).toEqual({
      valueCount: 1,
      files: [{ path: '.env.prod', valueNames: ['PROD_TOKEN'] }],
    });
  });

  it('tells the panel how varlock came to be running', async () => {
    const payload = v2Payload('mode');
    harness.setConfig({ plaintexts: { [payload]: 'x' } });
    process.env._VARLOCK_INVOCATION_MODE = 'auto-load';

    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.decryptIdentityPayloads([{ ciphertext: payload, keyId: 'varlock-default' }]);
    delete process.env._VARLOCK_INVOCATION_MODE;

    // A spawned auto-load is the same CLI a person would run, so the child has
    // to be told which it was; the daemon reads the command itself.
    const display = harness.callsOf('unlock-session')[0].payload.display as any;
    expect(display.invocationMode).toBe('auto-load');
  });

  it('still reports counts when the caller knows no value names', async () => {
    const payload = v2Payload('nameless');
    harness.setConfig({ plaintexts: { [payload]: 'x' } });

    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.decryptIdentityPayloads([{ ciphertext: payload, keyId: 'varlock-default' }]);

    const display = harness.callsOf('unlock-session')[0].payload.display as any;
    expect(display.keys['varlock-default']).toEqual({ valueCount: 1 });
  });

  it('keeps the vault decoration the caller supplied for a key', async () => {
    const payload = v2Payload('vaulted');
    harness.setConfig({ plaintexts: { [payload]: 'x' } });

    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.decryptIdentityPayloads(
      [{ ciphertext: payload, keyId: 'varlock-default', valueName: 'PROD_TOKEN' }],
      { display: { keys: { 'varlock-default': { vaultLabel: 'acme-team vault', vaultColor: '#b48ce8' } } } },
    );

    const display = harness.callsOf('unlock-session')[0].payload.display as any;
    expect(display.keys['varlock-default']).toEqual({
      vaultLabel: 'acme-team vault',
      vaultColor: '#b48ce8',
      valueCount: 1,
      files: [{ valueNames: ['PROD_TOKEN'] }],
    });
  });

  it('re-unlocks once when the grant dies between the unlock and the decrypt', async () => {
    const payload = v2Payload('racy');
    harness.setConfig({
      plaintexts: { [payload]: 'still-worked' },
      dropGrantsBeforeDecrypt: true,
    });

    const localEncrypt = await loadLocalEncrypt();
    const [plaintext] = await localEncrypt.decryptIdentityPayloads(
      [{ ciphertext: payload, keyId: 'varlock-default' }],
    );

    expect(plaintext).toBe('still-worked');
    // the first unlock, then the one the NO_SESSION_GRANT retry opened
    expect(harness.callsOf('unlock-session')).toHaveLength(2);
    expect(harness.callsOf('decrypt-v2')).toHaveLength(2);
  });

  it('surfaces a declined unlock as its own error, not a decryption failure', async () => {
    const payload = v2Payload('declined');
    harness.setConfig({
      plaintexts: { [payload]: 'never-seen' },
      unlockError: { code: 'APPROVAL_DENIED', message: 'user said no' },
    });

    const localEncrypt = await loadLocalEncrypt();
    const err = await localEncrypt
      .decryptIdentityPayloads([{ ciphertext: payload, keyId: 'varlock-default' }])
      .then(() => undefined, (e) => e);

    expect(err).toBeInstanceOf(localEncrypt.UnlockDeclinedError);
    expect(err.message).toMatch(/declined/i);
    // a refusal is final; it must not be retried into a second panel
    expect(harness.callsOf('unlock-session')).toHaveLength(1);
  });

  it('tells the user to use a GUI session when there is nowhere to ask', async () => {
    const payload = v2Payload('headless');
    harness.setConfig({
      plaintexts: { [payload]: 'never-seen' },
      unlockError: { code: 'NO_UI', message: 'no window server' },
    });

    const localEncrypt = await loadLocalEncrypt();
    const err = await localEncrypt
      .decryptIdentityPayloads([{ ciphertext: payload, keyId: 'varlock-default' }])
      .then(() => undefined, (e) => e);

    expect(err).toBeInstanceOf(localEncrypt.UnlockNoUiError);
    expect(err.message).toMatch(/graphical session/);
  });

  it('skips the unlock when this process already holds a live grant', async () => {
    const first = v2Payload('first');
    const second = v2Payload('second');
    harness.setConfig({ plaintexts: { [first]: 'a', [second]: 'b' } });

    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.decryptIdentityPayloads([{ ciphertext: first, keyId: 'varlock-default' }]);
    await localEncrypt.decryptIdentityPayloads([{ ciphertext: second, keyId: 'varlock-default' }]);

    // the second batch rode the first batch's grant: still one panel, one scan
    expect(harness.callsOf('unlock-session')).toHaveLength(1);
    expect(harness.callsOf('decrypt-v2')).toHaveLength(2);
  });

  it('routes a single v2 value through the same session flow', async () => {
    const payload = v2Payload('single');
    harness.setConfig({ plaintexts: { [payload]: 'one-value' } });

    const localEncrypt = await loadLocalEncrypt();
    expect(await localEncrypt.decryptValue(payload)).toBe('one-value');
    expect(harness.callsOf('unlock-session')).toHaveLength(1);
  });
});

describe.skipIf(process.platform === 'win32')('lock and sessions over the daemon', () => {
  it('lists what the daemon is holding', async () => {
    const payload = v2Payload('listed');
    harness.setConfig({ plaintexts: { [payload]: 'x' }, sessionId: 'tty:/dev/ttys009' });

    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.decryptIdentityPayloads([{ ciphertext: payload, keyId: 'varlock-default' }]);

    const sessions = await localEncrypt.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: 'tty:/dev/ttys009', keyId: 'varlock-default' });
  });

  it('locks one session by id, leaving the rest of the request shape alone', async () => {
    const payload = v2Payload('locked');
    harness.setConfig({ plaintexts: { [payload]: 'x' } });

    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.decryptIdentityPayloads([{ ciphertext: payload, keyId: 'varlock-default' }]);
    await localEncrypt.lockSession({ sessionId: 'fake-session' });

    const invalidations = harness.callsOf('invalidate-session');
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0].payload).toEqual({ sessionId: 'fake-session' });
  });

  it('reports the session id the daemon resolved, which is what --current locks', async () => {
    harness.setConfig({ sessionId: 'ptree:4242:99' });
    const localEncrypt = await loadLocalEncrypt();
    // a daemon has to be running for there to be a session at all
    await localEncrypt.getDaemonClient().ensureConnected();

    expect(await localEncrypt.getCurrentSessionId()).toBe('ptree:4242:99');
  });
});
