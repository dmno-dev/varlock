import os from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Resolves the user-level varlock config directory, respecting the XDG Base Directory Specification.
 *
 * Resolution order:
 * 1. If `$XDG_CONFIG_HOME` is set → `$XDG_CONFIG_HOME/varlock`
 * 2. If home directory is available and legacy `~/.varlock` exists → `~/.varlock` (backwards compatibility)
 * 3. If home directory is available → `~/.config/varlock` (XDG default)
 * 4. Otherwise → `$TMPDIR/varlock` (fallback when no home directory)
 *
 * @see https://specifications.freedesktop.org/basedir/latest/
 */
export function getUserVarlockDir(): string {
  // If XDG_CONFIG_HOME is explicitly set, always respect it
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'varlock');
  }

  const home = os.homedir();

  // If no home directory is available (e.g., some CI/container environments),
  // fall back to a temp directory so caches still work
  if (!home) {
    return join(os.tmpdir(), 'varlock');
  }

  // Backwards compatibility: if legacy ~/.varlock exists, keep using it
  const legacyDir = join(home, '.varlock');
  if (existsSync(legacyDir)) {
    return legacyDir;
  }

  // Default to XDG standard location: ~/.config/varlock
  return join(home, '.config', 'varlock');
}
