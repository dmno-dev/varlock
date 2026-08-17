/**
 * Resolves the path to the platform-specific native helper binary.
 *
 * Resolution order:
 * 1. SEA sibling: same directory as the running varlock binary (install.sh, standalone)
 * 1b. SEA libexec: ../libexec/ relative to the binary (homebrew convention)
 * 2. Platform npm package: @varlock/native-helper-<platform> (installed via
 *    varlock's optionalDependencies)
 * 3. Bundled in npm package: native-bins/<platform>[-<arch>]/ within the varlock
 *    package (legacy layout, and local dev builds staged by build scripts)
 * 4. Dev fallback: walk up from __dirname to find build output
 *
 * In a dev checkout (a real varlock package.json found outside node_modules),
 * strategy 2 is skipped (the workspace helper packages only hold transient
 * prepack copies) and strategies 3-4 are compared by binary mtime with the
 * newest winning, so stale staged copies never shadow a fresh local build.
 *
 * Returns undefined if no binary is found (file-based fallback will be used instead).
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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
 * Find the varlock package root by walking up from this module until we find
 * package.json with name=varlock. This is robust across src/dist layouts.
 * Returns undefined when no varlock package.json is found (e.g. varlock
 * bundled into an app's build output).
 */
let _cachedPackageRoot: string | undefined | null = null; // null = not yet resolved
function findVarlockPackageRoot(): string | undefined {
  if (_cachedPackageRoot !== null) return _cachedPackageRoot;
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { name?: string };
        if (pkgJson.name === 'varlock') {
          _cachedPackageRoot = dir;
          return dir;
        }
      } catch {
        // Ignore invalid/unreadable package.json and continue walking upward
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _cachedPackageRoot = undefined;
  return undefined;
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

/** The native-bins subdirs that have a published @varlock/native-helper-* package */
const PLATFORM_PACKAGE_SUFFIXES = new Set(['darwin', 'linux-x64', 'linux-arm64', 'win32-x64']);

/**
 * Get the per-platform npm package that carries the native binary for the
 * current platform, or undefined if there is no package for it.
 * Derived from getNativeBinSubdir() so the two can never disagree; WSL maps to
 * the win32 package (published with os win32+linux) so the Windows helper is
 * available for DPAPI + Windows Hello via interop.
 */
export function getPlatformPackageName(): string | undefined {
  const subdir = getNativeBinSubdir();
  return PLATFORM_PACKAGE_SUFFIXES.has(subdir) ? `@varlock/native-helper-${subdir}` : undefined;
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
 * Strategy 1: Look for the binary next to the running varlock binary,
 * then check ../libexec/ (homebrew convention for internal helpers).
 * This is the primary path for binary/SEA distribution.
 */
function resolveSeaSibling(): string | undefined {
  const execDir = path.dirname(fs.realpathSync(process.execPath));

  // 1a. Same directory as the binary (install.sh, standalone archives)
  const sibling = resolveBinaryFromDir(execDir);
  if (sibling) return sibling;

  // 1b. ../libexec/ relative to the binary (homebrew layout)
  const libexecDir = path.join(execDir, '..', 'libexec');
  return resolveBinaryFromDir(libexecDir);
}

/**
 * Strategy 2: Resolve the binary from the per-platform npm package
 * (@varlock/native-helper-*), installed via varlock's optionalDependencies.
 */
function resolvePlatformPackage(): string | undefined {
  const pkgName = getPlatformPackageName();
  if (!pkgName) return undefined;
  try {
    // createRequire may be unavailable in some bundled/compiled contexts, and
    // require.resolve throws when the optional dep was not installed
    const esmRequire = createRequire(import.meta.url);
    const pkgJsonPath = esmRequire.resolve(`${pkgName}/package.json`);
    return resolveBinaryFromDir(path.dirname(pkgJsonPath));
  } catch {
    return undefined;
  }
}

/**
 * Strategy 3: Look for the binary bundled in the varlock npm package.
 * native-bins/<platform-subdir>/
 * This is the pre-split layout (varlock <= 1.16.x shipped all platforms in one
 * tarball), and also where local dev build scripts stage binaries.
 */
function resolveNpmBundled(): string | undefined {
  const packageRoot = findVarlockPackageRoot();
  if (!packageRoot) return undefined;
  return resolveBinaryFromDir(path.join(packageRoot, 'native-bins', getNativeBinSubdir()));
}

/**
 * Strategy 4: Development fallback — look for build output in the monorepo.
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

/** Modification time of a binary, or 0 if it cannot be statted */
function getMtimeMs(binaryPath: string): number {
  try {
    return fs.statSync(binaryPath).mtimeMs;
  } catch {
    return 0;
  }
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

  if (process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK) {
    debug('_VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK is set — skipping native binary resolution');
    _cachedBinaryPath = undefined;
    return undefined;
  }

  debug(`resolving: platform=${process.platform}, isWSL=${isWSL()}, binaryName=${getPlatformBinaryName()}, subdir=${getNativeBinSubdir()}`);

  const seaSibling = resolveSeaSibling();
  if (seaSibling) {
    debug(`resolved via SEA sibling: ${seaSibling}`);
    _cachedBinaryPath = ensureExecutable(seaSibling);
    return _cachedBinaryPath;
  }

  // A dev checkout is the varlock monorepo itself (or a linked checkout): we
  // found a real varlock package.json and it is not under node_modules.
  const packageRoot = findVarlockPackageRoot();
  const isDevCheckout = !!packageRoot && !packageRoot.split(path.sep).includes('node_modules');

  const candidates: Array<{ binaryPath: string; via: string }> = [];
  if (!isDevCheckout) {
    // In a dev checkout the workspace-linked @varlock/native-helper-* packages
    // only ever hold transient copies made by their prepack script, so they are
    // not considered; real dev binaries live in native-bins/ or build output.
    const platformPackage = resolvePlatformPackage();
    if (platformPackage) candidates.push({ binaryPath: platformPackage, via: 'platform package' });
  }
  const npmBundled = resolveNpmBundled();
  if (npmBundled) candidates.push({ binaryPath: npmBundled, via: 'npm bundled' });
  const devFallback = resolveDevFallback();
  if (devFallback) candidates.push({ binaryPath: devFallback, via: 'dev fallback' });

  if (candidates.length) {
    let chosen = candidates[0];
    // In a dev checkout, a stale binary staged into native-bins/ would shadow a
    // fresh build forever, so prefer the most recently modified candidate.
    // npm installs keep strict priority order: their copies all come from the
    // same published version and file timestamps are just install times.
    if (isDevCheckout && candidates.length > 1) {
      chosen = candidates.reduce((a, b) => (getMtimeMs(b.binaryPath) > getMtimeMs(a.binaryPath) ? b : a));
      debug(`dev checkout with ${candidates.length} candidates - picking newest by mtime`);
    }
    debug(`resolved via ${chosen.via}: ${chosen.binaryPath}`);
    _cachedBinaryPath = ensureExecutable(chosen.binaryPath);
    return _cachedBinaryPath;
  }

  debug('NOT FOUND: no binary resolved from any strategy');
  debug(`  SEA sibling dir: ${path.dirname(process.execPath)}`);
  if (packageRoot) debug(`  npm bundled dir: ${path.join(packageRoot, 'native-bins', getNativeBinSubdir())}`);

  _cachedBinaryPath = undefined;
  return undefined;
}
