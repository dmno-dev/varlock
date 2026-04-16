import { execSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Acquire an exclusive file-based lock by atomic `mkdir`. Blocks with polling
 * until acquired. Returns a release function. Used to serialize `bun pm pack`
 * calls across parallel Vitest worker processes so they don't race on the
 * same output tarball path (which produces a corrupted archive).
 */
function withFileLock<T>(lockPath: string, fn: () => T): T {
  const start = Date.now();
  const LOCK_TIMEOUT_MS = 120_000;
  const STALE_LOCK_MS = 300_000;


  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      // If the lock dir is very old, assume it was left behind by a
      // crashed process and reclaim it.
      try {
        const { mtimeMs } = statSync(lockPath);
        if (Date.now() - mtimeMs > STALE_LOCK_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { /* ignore */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring pack lock at ${lockPath}`);
      }
      // busy-wait briefly (sync, since callers expect sync behavior)
      execSync('sleep 0.1');
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

const FRAMEWORK_TESTS_DIR = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(FRAMEWORK_TESTS_DIR, '..');
const PACKED_DIR = join(FRAMEWORK_TESTS_DIR, '.packed');

/** Map from package name to its directory relative to repo root */
const PACKAGE_DIRS: Record<string, string> = {
  varlock: 'packages/varlock',
  '@varlock/nextjs-integration': 'packages/integrations/nextjs',
  '@varlock/astro-integration': 'packages/integrations/astro',
  '@varlock/vite-integration': 'packages/integrations/vite',
  '@varlock/expo-integration': 'packages/integrations/expo',
  '@varlock/cloudflare-integration': 'packages/integrations/cloudflare',
};

/**
 * Finds an existing packed .tgz file for the given package name.
 */
function findPackedFile(packageName: string): string | undefined {
  if (!existsSync(PACKED_DIR)) return undefined;

  const files = readdirSync(PACKED_DIR).filter((f) => f.endsWith('.tgz'));

  // Package names like @varlock/nextjs-integration produce tgz files like
  // varlock-nextjs-integration-0.2.3.tgz (scoped @ and / are stripped/replaced)
  const normalizedName = packageName
    .replace(/^@/, '')
    .replace(/\//g, '-');

  const match = files.find((f) => f.startsWith(`${normalizedName}-`));
  return match ? join(PACKED_DIR, match) : undefined;
}

/**
 * Packs specified varlock packages into .packed/ directory.
 * Skips packages that are already packed unless REPACK env var is set.
 * Returns map of package name → absolute path to .tgz file.
 */
export function packPackages(
  packageNames: Array<string>,
): Record<string, string> {
  mkdirSync(PACKED_DIR, { recursive: true });

  const forceRepack = !!process.env.REPACK;

  const result: Record<string, string> = {};

  for (const name of packageNames) {
    const packageDir = PACKAGE_DIRS[name];
    if (!packageDir) {
      throw new Error(`Unknown package "${name}". Known packages: ${Object.keys(PACKAGE_DIRS).join(', ')}`);
    }

    // Serialize per-package across parallel Vitest workers. Without this,
    // two processes can simultaneously write the same .tgz path and
    // produce a corrupted tarball.
    const lockPath = join(PACKED_DIR, `.lock-${name.replace(/[@/]/g, '_')}`);
    result[name] = withFileLock(lockPath, () => {
      // Check if already packed (skip if forcing repack) — re-check inside
      // the lock so we pick up a tarball written by another worker.
      if (!forceRepack) {
        const existing = findPackedFile(name);
        if (existing) return existing;
      }

      // Remove old tarball if it exists (version may not have changed)
      const oldPacked = findPackedFile(name);
      if (oldPacked) {
        rmSync(oldPacked);
      }

      // Pack the package
      const fullPackageDir = join(REPO_ROOT, packageDir);
      console.log(`[pack] Packing ${name}...`);
      execSync(`bun pm pack --destination ${PACKED_DIR}`, {
        cwd: fullPackageDir,
        stdio: 'pipe',
      });

      const packed = findPackedFile(name);
      if (!packed) {
        throw new Error(`Failed to find packed file for "${name}" after packing`);
      }
      return packed;
    });
  }

  return result;
}

/**
 * Returns a dependencies object with file: paths to packed tarballs
 * for the given package names. Call packPackages first.
 */
export function getPackedDeps(packageNames: Array<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of packageNames) {
    const packed = findPackedFile(name);
    if (!packed) {
      throw new Error(`No packed file found for "${name}". Run packPackages() first.`);
    }
    result[name] = `file:${packed}`;
  }
  return result;
}
