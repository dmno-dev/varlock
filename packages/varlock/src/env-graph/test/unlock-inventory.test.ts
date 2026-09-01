/**
 * What the first unlock of a run is allowed to say, from the loading end.
 *
 * The panel that opens a session grant is the only one the user will see, so it
 * has to describe everything that grant covers. That cannot be worked out from
 * the batch that happens to ask first: the env files and the value cache are
 * opened by different callers at different moments. So the load declares the
 * whole picture up front, and these tests are about what a load declares.
 */

import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadEnvGraph } from '../lib/loader';
import { CacheStore } from '../../lib/cache';
import { VarlockResolver } from '../../lib/local-encrypt/builtin-resolver';
import { unlockInventoryForKey, clearUnlockInventory } from '../../lib/local-encrypt/unlock-inventory';

// a native backend, so the loader picks the disk cache the identity key opens
vi.mock('../../lib/local-encrypt', () => ({
  getBackendInfo: () => ({ type: 'secure-enclave', isFileFallback: false }),
  keyExists: () => true,
  ensureKey: vi.fn(async () => undefined),
  ensureEncryptionReady: vi.fn(async () => undefined),
  encryptValue: vi.fn(async (v: string) => `enc:${v}`),
  decryptValue: vi.fn(async (v: string) => v.replace('enc:', '')),
}));

let tempConfigDir: string;
vi.mock('../../lib/user-config-dir', () => ({
  getUserVarlockDir: () => tempConfigDir,
}));

let tempProjectDir: string;

/** A `varlock()` reference whose payload carries a real v2 version byte */
function encryptedRef(marker: string) {
  const payload = Buffer.concat([Buffer.from([0x02]), Buffer.from(marker, 'utf-8')]).toString('base64');
  return `varlock("local:${payload}")`;
}

/** A reference to a device-key (v1) payload, which no session grant covers */
function legacyRef(marker: string) {
  const payload = Buffer.concat([Buffer.from([0x01]), Buffer.from(marker, 'utf-8')]).toString('base64');
  return `varlock("local:${payload}")`;
}

function writeEnvFile(name: string, lines: Array<string>) {
  fs.writeFileSync(path.join(tempProjectDir, name), `${lines.join('\n')}\n`);
}

/**
 * How the panel names one of these files. A file under the working directory is
 * named relative to it; this test's project is a temp dir that is not, so the
 * full path is what the declaration carries.
 */
function shownAs(name: string) {
  return path.join(tempProjectDir, name);
}

beforeEach(() => {
  clearUnlockInventory();
  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-unlock-inventory-config-'));
  tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-unlock-inventory-proj-'));
  writeEnvFile('.env.schema', ['# @defaultRequired=false', '# ---', 'PLAIN=hello']);
});

afterEach(() => {
  clearUnlockInventory();
  fs.rmSync(tempConfigDir, { recursive: true, force: true });
  fs.rmSync(tempProjectDir, { recursive: true, force: true });
});

async function load() {
  return loadEnvGraph({
    basePath: tempProjectDir,
    processEnvOverride: {},
    // the same registration the real loader does
    afterInit: async (graph) => { graph.registerResolver(VarlockResolver); },
  });
}

describe('what a load declares to the unlock panel', () => {
  it('names every encrypted value in the graph, before any of them resolve', async () => {
    writeEnvFile('.env', [`DB_URL=${encryptedRef('db')}`]);
    writeEnvFile('.env.local', [
      `STRIPE_KEY=${encryptedRef('stripe')}`,
      `NGROK_TOKEN=${encryptedRef('ngrok')}`,
    ]);

    await load();

    expect(unlockInventoryForKey('varlock-default')).toEqual([
      { kind: 'file', path: shownAs('.env'), entries: [{ name: 'DB_URL' }] },
      {
        kind: 'file',
        path: shownAs('.env.local'),
        entries: [{ name: 'STRIPE_KEY' }, { name: 'NGROK_TOKEN' }],
      },
    ]);
  });

  it('lists the value cache beside the files that share its key', async () => {
    writeEnvFile('.env.local', [`STRIPE_KEY=${encryptedRef('stripe')}`]);
    const cache = new CacheStore();
    await cache.set('plugin:1password:vault/db', 'a', 60_000);
    await cache.set('plugin:1password:vault/api', 'b', 60_000);

    await load();

    expect(unlockInventoryForKey('varlock-default')).toEqual([
      { kind: 'file', path: shownAs('.env.local'), entries: [{ name: 'STRIPE_KEY' }] },
      {
        kind: 'cache',
        itemCount: 2,
        entries: [{ name: '1password', count: 2 }],
      },
    ]);
  });

  it('leaves an empty cache off, since the grant will open nothing in it', async () => {
    writeEnvFile('.env.local', [`STRIPE_KEY=${encryptedRef('stripe')}`]);

    await load();

    expect(unlockInventoryForKey('varlock-default')).toEqual([{ kind: 'file', path: shownAs('.env.local'), entries: [{ name: 'STRIPE_KEY' }] }]);
  });

  it('drops a cache the next run does not use', async () => {
    const cache = new CacheStore();
    await cache.set('plugin:1password:vault/db', 'a', 60_000);
    await load();
    expect(unlockInventoryForKey('varlock-default')).toHaveLength(1);

    // @cache=disabled means nothing on this key opens a cache file
    writeEnvFile('.env.schema', [
      '# @defaultRequired=false',
      '# @cache=disabled',
      '# ---',
      `STRIPE_KEY=${encryptedRef('stripe')}`,
    ]);
    await load();

    expect(unlockInventoryForKey('varlock-default')).toEqual([{ kind: 'file', path: shownAs('.env.schema'), entries: [{ name: 'STRIPE_KEY' }] }]);
  });

  it('forgets a value that a later load no longer defines', async () => {
    writeEnvFile('.env.local', [
      `STRIPE_KEY=${encryptedRef('stripe')}`,
      `NGROK_TOKEN=${encryptedRef('ngrok')}`,
    ]);
    await load();
    expect(unlockInventoryForKey('varlock-default')[0].entries).toHaveLength(2);

    writeEnvFile('.env.local', [`STRIPE_KEY=${encryptedRef('stripe')}`]);
    await load();

    expect(unlockInventoryForKey('varlock-default')).toEqual([{ kind: 'file', path: shownAs('.env.local'), entries: [{ name: 'STRIPE_KEY' }] }]);
  });

  /**
   * A value a later file overrides is never opened, so listing it would promise
   * something the approval does not buy.
   */
  it('leaves out a value a later file has overridden', async () => {
    writeEnvFile('.env', [`STRIPE_KEY=${encryptedRef('old')}`]);
    writeEnvFile('.env.local', ['STRIPE_KEY=plain-value']);

    await load();

    expect(unlockInventoryForKey('varlock-default')).toEqual([]);
  });

  /** Only identity-encrypted values ride a session grant; a v1 payload asks its own way */
  it('leaves out device-key values, which no unlock session covers', async () => {
    writeEnvFile('.env.local', [
      `OLD_KEY=${legacyRef('legacy')}`,
      `STRIPE_KEY=${encryptedRef('stripe')}`,
    ]);

    await load();

    expect(unlockInventoryForKey('varlock-default')).toEqual([{ kind: 'file', path: shownAs('.env.local'), entries: [{ name: 'STRIPE_KEY' }] }]);
  });
});
