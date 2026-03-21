import path from 'node:path';
import fs from 'node:fs';

export type VarlockPackageJsonConfig = {
  /** Path to a specific .env file or directory to use as the entry point for loading */
  loadPath?: string;
};

/**
 * Reads varlock configuration from the nearest `package.json` file.
 * Looks for a `varlock` key in the nearest `package.json` found by walking up from `cwd`.
 * Returns undefined if no `package.json` with a `varlock` key is found.
 */
export function readVarlockPackageJsonConfig(opts?: { cwd?: string }): VarlockPackageJsonConfig | undefined {
  let cwd = opts?.cwd ?? process.cwd();

  while (true) {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.varlock && typeof pkg.varlock === 'object') {
          return pkg.varlock as VarlockPackageJsonConfig;
        }
      } catch { /* ignore parse errors */ }
      // Found a package.json without varlock key - stop searching, this is the project root
      break;
    }
    const parent = path.dirname(cwd);
    if (parent === cwd) break; // reached filesystem root
    cwd = parent;
  }

  return undefined;
}
