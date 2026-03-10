import os from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Resolves the user-level varlock config directory, respecting the XDG Base Directory Specification.
 *
 * Resolution order:
 * 1. If `$XDG_CONFIG_HOME` is set → `$XDG_CONFIG_HOME/varlock`
 * 2. If legacy `~/.varlock` exists → `~/.varlock` (backwards compatibility)
 * 3. Otherwise → `~/.config/varlock` (XDG default)
 *
 * @see https://specifications.freedesktop.org/basedir/latest/
 */
export function getUserVarlockDir(): string {
  const home = os.homedir();

  // If XDG_CONFIG_HOME is explicitly set, always respect it
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'varlock');
  }

  // Backwards compatibility: if legacy ~/.varlock exists, keep using it
  const legacyDir = join(home, '.varlock');
  if (existsSync(legacyDir)) {
    return legacyDir;
  }

  // Default to XDG standard location: ~/.config/varlock
  return join(home, '.config', 'varlock');
}
