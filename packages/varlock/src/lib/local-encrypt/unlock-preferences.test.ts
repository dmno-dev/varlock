/**
 * Forgetting remembered unlock narrowings from this side.
 *
 * The daemon writes the file; this only ever deletes rows out of it. So the
 * tests are about not deleting more than asked, and about doing nothing at all
 * when there is nothing to do.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

let userVarlockDir: string;

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => userVarlockDir,
}));

async function loadModule() {
  vi.resetModules();
  return import('./unlock-preferences');
}

/** The daemon's own row key: project path, a NUL, then the key id */
function row(projectPath: string, keyId: string) {
  return `${projectPath}\u0000${keyId}`;
}

function writeFileWith(rows: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(userVarlockDir, 'unlock-preferences.json'),
    JSON.stringify({ version: 1, projects: rows }, null, 2),
  );
}

function readRows(): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(userVarlockDir, 'unlock-preferences.json'), 'utf-8');
  return JSON.parse(raw).projects;
}

beforeEach(() => {
  userVarlockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-prefs-'));
});

afterEach(() => {
  fs.rmSync(userVarlockDir, { recursive: true, force: true });
});

describe('forgetting remembered unlock choices', () => {
  it('forgets one project and leaves the others alone', async () => {
    writeFileWith({
      [row('/code/acme', 'varlock-default')]: { breadth: 'listed', approvedBefore: true },
      [row('/code/acme', 'other-key')]: { scope: 'once', approvedBefore: true },
      [row('/code/elsewhere', 'varlock-default')]: { breadth: 'listed', approvedBefore: true },
    });

    const { forgetUnlockPreferences } = await loadModule();
    expect(forgetUnlockPreferences({ projectPath: '/code/acme' })).toBe(2);
    expect(Object.keys(readRows())).toEqual([row('/code/elsewhere', 'varlock-default')]);
  });

  it('forgets everything when no project is named', async () => {
    writeFileWith({
      [row('/code/acme', 'varlock-default')]: { breadth: 'listed', approvedBefore: true },
      [row('/code/elsewhere', 'varlock-default')]: { breadth: 'listed', approvedBefore: true },
    });

    const { forgetUnlockPreferences } = await loadModule();
    expect(forgetUnlockPreferences()).toBe(2);
    expect(readRows()).toEqual({});
  });

  it('reports nothing to forget rather than creating a file', async () => {
    const { forgetUnlockPreferences, unlockPreferencesPath } = await loadModule();
    expect(forgetUnlockPreferences()).toBe(0);
    expect(fs.existsSync(unlockPreferencesPath())).toBe(false);
  });

  it('leaves a file it cannot parse exactly as it found it', async () => {
    const filePath = path.join(userVarlockDir, 'unlock-preferences.json');
    fs.writeFileSync(filePath, 'half a write');

    const { forgetUnlockPreferences } = await loadModule();
    expect(forgetUnlockPreferences()).toBe(0);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('half a write');
  });

  it('does not rewrite the file when the named project has nothing in it', async () => {
    writeFileWith({ [row('/code/acme', 'varlock-default')]: { breadth: 'listed', approvedBefore: true } });
    const filePath = path.join(userVarlockDir, 'unlock-preferences.json');
    const before = fs.readFileSync(filePath, 'utf-8');

    const { forgetUnlockPreferences } = await loadModule();
    expect(forgetUnlockPreferences({ projectPath: '/code/nothing-here' })).toBe(0);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
  });
});
