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
 * Returns `null` when no valid home directory is available (e.g., Docker with no HOME set).
 *
 * @see https://specifications.freedesktop.org/basedir/latest/
 */
export function getUserVarlockDir(): string | null {
  // If XDG_CONFIG_HOME is explicitly set, always respect it (even without a home dir)
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'varlock');
  }

  const home = os.homedir();

  // Node.js returns '/dev/null' when HOME is unset and no passwd entry exists (e.g., Docker)
  if (home === '/dev/null') {
    return null;
  }

  // Backwards compatibility: if legacy ~/.varlock exists, keep using it
  const legacyDir = join(home, '.varlock');
  if (existsSync(legacyDir)) {
    return legacyDir;
  }

  // Default to XDG standard location: ~/.config/varlock
  return join(home, '.config', 'varlock');
}

/**
 * Resolves the plugin cache directory.
 *
 * Uses `<userVarlockDir>/plugins-cache` when a user config directory is available,
 * or falls back to a system temp directory (`<tmpdir>/varlock-plugins-cache`) for
 * environments without a home folder (e.g., Docker containers with no HOME set).
 *
 * Note: the temp-dir fallback is not persistent across container restarts. In Docker
 * you can avoid repeated downloads by mounting a volume at the user varlock dir or
 * by setting the HOME (or XDG_CONFIG_HOME) env var to a persistent path.
 */
export function getPluginCacheDir(): string {
  const userDir = getUserVarlockDir();
  if (userDir) {
    return join(userDir, 'plugins-cache');
  }
  // Fallback for environments with no home directory (e.g., Docker with no HOME set)
  return join(os.tmpdir(), 'varlock-plugins-cache');
}
