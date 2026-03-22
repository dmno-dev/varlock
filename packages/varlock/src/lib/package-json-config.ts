import path from 'node:path';
import fs from 'node:fs';

export type VarlockPackageJsonConfig = {
  /** Path to a specific .env file or directory to use as the entry point for loading */
  loadPath?: string;
};

/**
 * Reads varlock configuration from the `package.json` in `cwd`.
 * Returns undefined if no `package.json` exists or it has no `varlock` key.
 */
export function readVarlockPackageJsonConfig(opts?: { cwd?: string }): VarlockPackageJsonConfig | undefined {
  const cwd = opts?.cwd ?? process.cwd();
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.varlock && typeof pkg.varlock === 'object') {
      return pkg.varlock as VarlockPackageJsonConfig;
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}
