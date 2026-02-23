/**
 * Lists all workspace packages by reading the root package.json workspaces globs
 * and finding all package.json files that match.
 * Returns an array of { name, version, path } objects (same shape as `pnpm m ls --json`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'node:fs/promises';

export async function listWorkspaces(monorepoRoot) {
  const rootPkgJson = JSON.parse(fs.readFileSync(path.join(monorepoRoot, 'package.json'), 'utf-8'));
  const patterns = rootPkgJson.workspaces || [];

  const includePatterns = patterns.filter((p) => !p.startsWith('!'));
  const excludePatterns = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

  const results = [];
  for (const pattern of includePatterns) {
    const pkgJsonPattern = `${pattern}/package.json`;
    for await (const match of glob(pkgJsonPattern, {
      cwd: monorepoRoot,
      exclude: (p) => p === 'node_modules',
    })) {
      const fullPath = path.resolve(monorepoRoot, match);
      const pkgDir = path.dirname(fullPath);
      const relativePkgDir = path.relative(monorepoRoot, pkgDir);

      // check against exclude patterns
      const excluded = excludePatterns.some((ep) => {
        // simple glob match - convert glob to regex
        const regexStr = ep.replace(/\*\*/g, '___GLOBSTAR___').replace(/\*/g, '[^/]*').replace(/___GLOBSTAR___/g, '.*');
        return new RegExp(`^${regexStr}$`).test(relativePkgDir)
          || new RegExp(`^${regexStr}/`).test(relativePkgDir)
          || new RegExp(`^${regexStr}$`).test(`${relativePkgDir}/package.json`);
      });
      if (excluded) continue;

      try {
        const pkgJson = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        results.push({
          name: pkgJson.name,
          version: pkgJson.version,
          path: pkgDir,
        });
      } catch {
        // skip invalid package.json files
      }
    }
  }

  return results;
}
