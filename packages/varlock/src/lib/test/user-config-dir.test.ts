import {
  describe, test, expect, vi, beforeEach, afterEach,
} from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// We need to isolate the module for each test so env/fs state doesn't bleed
describe('getUserVarlockDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-config-dir-test-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns XDG_CONFIG_HOME/varlock when XDG_CONFIG_HOME is set', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', tmpDir);
    const { getUserVarlockDir } = await import('../user-config-dir');
    expect(getUserVarlockDir()).toBe(path.join(tmpDir, 'varlock'));
  });

  test('returns legacy ~/.varlock when it exists', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    // Simulate a home directory that has the legacy .varlock folder
    const fakeHome = path.join(tmpDir, 'home');
    const legacyDir = path.join(fakeHome, '.varlock');
    fs.mkdirSync(legacyDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const { getUserVarlockDir } = await import('../user-config-dir');
    expect(getUserVarlockDir()).toBe(legacyDir);
  });

  test('returns ~/.config/varlock by default (XDG standard)', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    // No legacy .varlock folder
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const { getUserVarlockDir } = await import('../user-config-dir');
    expect(getUserVarlockDir()).toBe(path.join(fakeHome, '.config', 'varlock'));
  });

  test('returns null when HOME is unavailable (Docker with no HOME)', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.spyOn(os, 'homedir').mockReturnValue('/dev/null');
    const { getUserVarlockDir } = await import('../user-config-dir');
    expect(getUserVarlockDir()).toBeNull();
  });
});

describe('getPluginCacheDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-plugin-cache-test-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns user varlock dir + plugins-cache when home is available', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const { getPluginCacheDir } = await import('../user-config-dir');
    expect(getPluginCacheDir()).toBe(path.join(fakeHome, '.config', 'varlock', 'plugins-cache'));
  });

  test('falls back to tmpdir/varlock-plugins-cache when HOME is unavailable', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.spyOn(os, 'homedir').mockReturnValue('/dev/null');
    const { getPluginCacheDir } = await import('../user-config-dir');
    expect(getPluginCacheDir()).toBe(path.join(os.tmpdir(), 'varlock-plugins-cache'));
  });
});
