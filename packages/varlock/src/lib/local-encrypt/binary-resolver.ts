/**
 * Resolves the path to the platform-specific native helper binary.
 *
 * Resolution order:
 * 1. SEA sibling: same directory as the running varlock binary (install.sh, homebrew)
 * 2. Bundled in npm package: native-bins/<platform>[-<arch>]/ within the varlock package
 * 3. Dev fallback: walk up from __dirname to find build output
 *
 * Returns undefined if no binary is found (file-based fallback will be used instead).
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isWSL } from './wsl-detect';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Debug logger — prints to stderr when VARLOCK_DEBUG is set */
function debug(msg: string) {
  if (process.env.VARLOCK_DEBUG) {
    process.stderr.write(`[varlock:binary-resolver] ${msg}\n`);
  }
}

const BINARY_NAME = 'varlock-local-encrypt';
const MACOS_APP_BUNDLE = 'VarlockEnclave.app';

/**
 * Resolve the varlock package root by walking up from this module until we
 * find package.json with name=varlock. This is robust across src/dist layouts.
 */
function resolvePackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { name?: string };
        if (pkgJson.name === 'varlock') return dir;
      } catch {
        // Ignore invalid/unreadable package.json and continue walking upward
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Last-resort fallback for unexpected layouts.
  return path.resolve(__dirname, '..', '..', '..');
}

/** Get the binary name for the current platform */
function getPlatformBinaryName(): string {
  if (process.platform === 'win32' || isWSL()) return `${BINARY_NAME}.exe`;
  return BINARY_NAME;
}

/** Get the subdirectory name within native-bins/ for the current platform */
function getNativeBinSubdir(): string {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return `win32-${process.arch}`;
  // WSL2: use the Windows binary for DPAPI + Windows Hello support
  if (isWSL()) return 'win32-x64';
  return `${process.platform}-${process.arch}`;
}

/**
 * Resolve the macOS .app bundle binary path, or fall back to bare binary.
 */
function resolveMacOSBinary(dir: string): string | undefined {
  // Try .app bundle first (needed for custom Touch ID icon)
  const appBundlePath = path.join(dir, MACOS_APP_BUNDLE, 'Contents', 'MacOS', BINARY_NAME);
  if (fs.existsSync(appBundlePath)) return appBundlePath;

  // Fall back to bare binary
  const barePath = path.join(dir, BINARY_NAME);
  if (fs.existsSync(barePath)) return barePath;

  return undefined;
}

/**
 * Resolve the binary path for Linux/Windows.
 */
function resolveStandardBinary(dir: string): string | undefined {
  const binaryPath = path.join(dir, getPlatformBinaryName());
  if (fs.existsSync(binaryPath)) return binaryPath;
  return undefined;
}

/**
 * Resolve binary from a directory, handling macOS .app bundle vs standard binary.
 */
function resolveBinaryFromDir(dir: string): string | undefined {
  if (process.platform === 'darwin') return resolveMacOSBinary(dir);
  return resolveStandardBinary(dir);
}

/**
 * Strategy 1: Look for the binary next to the running varlock binary.
 * This is the primary path for binary/SEA distribution (install.sh, homebrew).
 */
function resolveSeaSibling(): string | undefined {
  const execDir = path.dirname(fs.realpathSync(process.execPath));
  return resolveBinaryFromDir(execDir);
}

/**
 * Strategy 2: Look for the binary bundled in the varlock npm package.
 * native-bins/<platform-subdir>/
 */
function resolveNpmBundled(): string | undefined {
  const packageRoot = resolvePackageRoot();
  const nativeBinsDir = path.join(packageRoot, 'native-bins', getNativeBinSubdir());
  if (fs.existsSync(nativeBinsDir)) return resolveBinaryFromDir(nativeBinsDir);

  // Legacy/alternate layout: native-bins as a sibling of the package root.
  const adjacentNativeBinsDir = path.join(path.dirname(packageRoot), 'native-bins', getNativeBinSubdir());
  if (fs.existsSync(adjacentNativeBinsDir)) return resolveBinaryFromDir(adjacentNativeBinsDir);

  return undefined;
}

/**
 * Strategy 3: Development fallback — look for build output in the monorepo.
 * Walks up from __dirname looking for native binary build output
 */
function resolveDevFallback(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;

    // Check for Swift build output (macOS)
    if (process.platform === 'darwin') {
      const swiftBuild = path.join(dir, 'packages', 'encryption-binary-swift', 'swift', '.build', 'release', 'VarlockEnclave');
      if (fs.existsSync(swiftBuild)) return swiftBuild;
    }

    // Check for Rust build output (Linux/Windows)
    const rustBuild = path.join(dir, 'packages', 'encryption-binary-rust', 'target', 'release', getPlatformBinaryName());
    if (fs.existsSync(rustBuild)) return rustBuild;
  }

  return undefined;
}

/**
 * Ensure the binary at the given path is executable.
 * GitHub Actions artifact upload/download strips execute permissions,
 * and some extraction tools may do the same.
 */
function ensureExecutable(binaryPath: string): string {
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch {
    // Not executable — try to fix it
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }
  }
  return binaryPath;
}

/**
 * Resolve the native helper binary path.
 * Returns undefined if no binary is found — caller should fall back to pure JS.
 */
let _cachedBinaryPath: string | undefined | null = null; // null = not yet resolved

export function resolveNativeBinary(): string | undefined {
  if (_cachedBinaryPath !== null) return _cachedBinaryPath;

  debug(`resolving: platform=${process.platform}, isWSL=${isWSL()}, binaryName=${getPlatformBinaryName()}, subdir=${getNativeBinSubdir()}`);

  const seaSibling = resolveSeaSibling();
  if (seaSibling) {
    debug(`resolved via SEA sibling: ${seaSibling}`);
    _cachedBinaryPath = ensureExecutable(seaSibling);
    return _cachedBinaryPath;
  }

  const npmBundled = resolveNpmBundled();
  if (npmBundled) {
    debug(`resolved via npm bundled: ${npmBundled}`);
    _cachedBinaryPath = ensureExecutable(npmBundled);
    return _cachedBinaryPath;
  }

  const devFallback = resolveDevFallback();
  if (devFallback) {
    debug(`resolved via dev fallback: ${devFallback}`);
    _cachedBinaryPath = ensureExecutable(devFallback);
    return _cachedBinaryPath;
  }

  debug('NOT FOUND: no binary resolved from any strategy');
  debug(`  SEA sibling dir: ${path.dirname(process.execPath)}`);
  const packageRoot = resolvePackageRoot();
  debug(`  npm bundled dir: ${path.join(packageRoot, 'native-bins', getNativeBinSubdir())}`);
  _cachedBinaryPath = undefined;
  return undefined;
}
