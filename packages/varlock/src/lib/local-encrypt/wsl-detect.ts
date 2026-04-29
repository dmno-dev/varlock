/**
 * WSL detection utility.
 *
 * When running inside WSL, we use the Windows encryption binary (.exe)
 * to get DPAPI key protection and Windows Hello biometric support.
 */

import fs from 'node:fs';

let _isWSL: boolean | undefined;

/** Detect whether we're running inside WSL (1 or 2). Cached after first call. */
export function isWSL(): boolean {
  if (_isWSL !== undefined) return _isWSL;

  // Fast path: WSL always sets this env var
  if (process.env.WSL_DISTRO_NAME) {
    _isWSL = true;
    return true;
  }

  // Fallback: check /proc/version for Microsoft/WSL signature
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8');
    _isWSL = /microsoft|wsl/i.test(version);
  } catch {
    _isWSL = false;
  }

  return _isWSL;
}
