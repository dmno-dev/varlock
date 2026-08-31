/**
 * What happens when the daemon outlives an upgrade.
 *
 * A daemon started before varlock was updated keeps serving the protocol it was
 * built with, and the ops this build depends on simply are not there. Rather than
 * failing with "Unknown action", the client notices the version, terminates the
 * old process, and lets the next connect start one from the binary now on disk.
 * Once. If the replacement is also old, the installed helper is old and saying so
 * is more useful than restarting forever.
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

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: () => JSON.stringify({
      backend: 'secure-enclave',
      hardwareBacked: true,
      biometricAvailable: true,
      keys: ['varlock-default'],
      keyDetails: [{ keyId: 'varlock-default', requireAuth: true }],
    }),
  };
});

function v2Payload(marker: string): string {
  return Buffer.concat([Buffer.from([0x02]), Buffer.from(marker, 'utf-8')]).toString('base64');
}

async function loadLocalEncrypt() {
  vi.resetModules();
  return import('./index');
}

/** Wait for a pid to go away, so the test is not racing the kill */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!FakeDaemonHarness.isAlive(pid)) return true;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return false;
}

let stderrWrites: Array<string>;

beforeEach(() => {
  harness = new FakeDaemonHarness();
  stderrWrites = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderrWrites.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  harness.cleanup();
});

describe.skipIf(process.platform === 'win32')('a daemon older than this build', () => {
  it('is terminated and replaced, with a note on stderr', async () => {
    // an old daemon left running from before the upgrade
    harness.setConfig({ protocolVersion: 1 });
    const stalePid = await harness.startExistingDaemon();

    // the binary on disk is the new one, so a restart gets a newer daemon
    const payload = v2Payload('after-restart');
    harness.setConfig({ protocolVersion: 3, plaintexts: { [payload]: 'opened' } });

    const localEncrypt = await loadLocalEncrypt();
    const [plaintext] = await localEncrypt.decryptIdentityPayloads(
      [{ ciphertext: payload, keyId: 'varlock-default' }],
    );

    expect(plaintext).toBe('opened');
    expect(await waitForExit(stalePid)).toBe(true);

    const note = stderrWrites.join('');
    expect(note).toContain('protocol v1');
    expect(note).toContain('Restarting it');

    // the old daemon was asked its version and nothing else: no session op was
    // ever sent to a daemon that could not have served it
    const oldDaemonCalls = harness.calls().filter((call) => call.pid === stalePid);
    expect(oldDaemonCalls.map((call) => call.action)).toEqual(['ping']);
  });

  it('gives up with a reinstall message when the replacement is old too', async () => {
    // the binary itself is old here, so whatever gets spawned speaks v1 as well
    harness.setConfig({ protocolVersion: 1 });
    await harness.startExistingDaemon();

    const localEncrypt = await loadLocalEncrypt();
    const err = await localEncrypt
      .decryptIdentityPayloads([{ ciphertext: v2Payload('nope'), keyId: 'varlock-default' }])
      .then(() => undefined, (e) => e);

    expect(err).toBeInstanceOf(localEncrypt.StaleDaemonError);
    expect(err.message).toContain('speaks protocol v1');
    expect(err.message).toMatch(/Reinstall varlock/);
  });

  it('restarts at most once, however many ops are attempted', async () => {
    harness.setConfig({ protocolVersion: 1 });
    await harness.startExistingDaemon();

    const localEncrypt = await loadLocalEncrypt();
    const attempt = () => localEncrypt
      .decryptIdentityPayloads([{ ciphertext: v2Payload('x'), keyId: 'varlock-default' }])
      .then(() => undefined, (e) => e);

    expect(await attempt()).toBeInstanceOf(localEncrypt.StaleDaemonError);
    // the second attempt must not kill and respawn all over again
    expect(await attempt()).toBeInstanceOf(localEncrypt.StaleDaemonError);

    const restartNotes = stderrWrites.filter((line) => line.includes('Restarting it'));
    expect(restartNotes).toHaveLength(1);
  });

  it('leaves a current daemon alone', async () => {
    const payload = v2Payload('current');
    harness.setConfig({ protocolVersion: 3, plaintexts: { [payload]: 'fine' } });
    const pid = await harness.startExistingDaemon();

    const localEncrypt = await loadLocalEncrypt();
    await localEncrypt.decryptIdentityPayloads([{ ciphertext: payload, keyId: 'varlock-default' }]);

    expect(FakeDaemonHarness.isAlive(pid)).toBe(true);
    expect(stderrWrites.join('')).not.toContain('Restarting it');
  });
});
