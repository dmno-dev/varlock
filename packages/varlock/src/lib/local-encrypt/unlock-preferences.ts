/**
 * The narrowings this Mac remembers from unlock panels.
 *
 * Written by the daemon, which is the side that saw the answer. Read here only
 * to forget them: the file lives in the user's own varlock directory, so a
 * `varlock lock --forget-preferences` is a file edit rather than a round trip
 * through a daemon that may not even be running.
 *
 * Choosing the broad default on the panel already forgets a narrowing, which is
 * the way most people will do it. This is for the case where you want them gone
 * without waiting to be asked again.
 *
 * The format is owned by `UnlockPreferences.swift`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getUserVarlockDir } from '../user-config-dir';

const FILE_NAME = 'unlock-preferences.json';
/** Rows are keyed `<project path>\0<key id>` */
const ROW_SEPARATOR = '\u0000';

export function unlockPreferencesPath(): string {
  return path.join(getUserVarlockDir(), FILE_NAME);
}

/**
 * Forget remembered narrowings.
 *
 * Omitting `projectPath` forgets every one on the machine. Returns how many
 * rows were dropped, so the caller can say something true about a file that
 * was already empty.
 */
export function forgetUnlockPreferences(opts?: { projectPath?: string }): number {
  const filePath = unlockPreferencesPath();
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    // No file, or one nothing can read. Either way there is nothing to forget,
    // and rewriting a file we could not parse would throw away more than asked.
    return 0;
  }
  const rows = (parsed?.projects ?? {}) as Record<string, unknown>;
  const keys = Object.keys(rows);
  if (keys.length === 0) return 0;

  const kept: Record<string, unknown> = {};
  let forgotten = 0;
  for (const key of keys) {
    const rowProject = key.split(ROW_SEPARATOR)[0];
    if (!opts?.projectPath || opts.projectPath === rowProject) forgotten += 1;
    else kept[key] = rows[key];
  }
  if (forgotten === 0) return 0;

  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ ...parsed, projects: kept }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return forgotten;
}
