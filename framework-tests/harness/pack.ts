import { execSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

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

    // Check if already packed (skip if forcing repack)
    if (!forceRepack) {
      const existing = findPackedFile(name);
      if (existing) {
        result[name] = existing;
        continue;
      }
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
    result[name] = packed;
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
