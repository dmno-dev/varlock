/**
 * Lists all workspace packages by reading the root package.json workspaces globs
 * and finding all package.json files that match.
 * Returns an array of { name, version, path } objects (same shape as `pnpm m ls --json`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

/**
 * Simple glob-style matching for workspace patterns.
 * Handles `packages/**\/*` style patterns by walking directories.
 */
async function findPackageJsons(pattern, cwd) {
  const matches = [];

  // Convert workspace glob pattern to a directory walk
  // e.g. "packages/**/*" -> walk packages/ recursively
  const parts = pattern.split('**/');

  if (parts.length === 2) {
    // Pattern like "packages/**/*" — walk recursively from the base dir
    const baseDir = path.join(cwd, parts[0]);
    if (!fs.existsSync(baseDir)) return matches;
    await walkDir(baseDir, cwd, matches);
  } else {
    // Pattern like "packages/*" — single level
    const baseDir = path.join(cwd, pattern.replace(/\/?\*$/, ''));
    if (!fs.existsSync(baseDir)) return matches;
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const pkgJsonPath = path.join(baseDir, entry.name, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        matches.push(path.relative(cwd, pkgJsonPath));
      }
    }
  }

  return matches;
}

async function walkDir(dir, cwd, matches) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const fullDir = path.join(dir, entry.name);
    const pkgJsonPath = path.join(fullDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      matches.push(path.relative(cwd, pkgJsonPath));
    }
    // Continue recursing
    await walkDir(fullDir, cwd, matches);
  }
}

export async function listWorkspaces(monorepoRoot) {
  const rootPkgJson = JSON.parse(fs.readFileSync(path.join(monorepoRoot, 'package.json'), 'utf-8'));
  const patterns = rootPkgJson.workspaces || [];

  const includePatterns = patterns.filter((p) => !p.startsWith('!'));
  const excludePatterns = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

  const results = [];
  for (const pattern of includePatterns) {
    const matches = await findPackageJsons(pattern, monorepoRoot);
    for (const match of matches) {
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
