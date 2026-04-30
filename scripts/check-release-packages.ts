/**
 * Determines which packages would be published in a preview release.
 * Uses `bumpy status --json` to find packages with pending changesets,
 * then filters to only packages that actually changed in this PR
 * (plus their workspace dependencies, so preview packages can reference each other).
 *
 * Usage:
 *   bun run scripts/check-release-packages.ts
 *
 * Outputs (via GITHUB_OUTPUT if available):
 *   packages=["path1","path2"]
 *   includes-varlock=true|false
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspaces } from './list-workspaces';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MONOREPO_ROOT = path.resolve(__dirname, '..');

let bumpyStatusRaw: string;
try {
  bumpyStatusRaw = execSync('bunx @varlock/bumpy status --json 2>/dev/null', { cwd: MONOREPO_ROOT }).toString();
} catch (execErr: any) {
  // bumpy may exit non-zero with warnings but still output valid JSON
  bumpyStatusRaw = execErr.stdout?.toString() ?? '';
}

let releasePackagePaths: Array<string> = [];

if (bumpyStatusRaw) {
  // stdout may contain warning lines before the JSON — extract just the JSON
  const jsonMatch = bumpyStatusRaw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const bumpyStatus = JSON.parse(jsonMatch[0]);
    const bumpyReleases = bumpyStatus.releases
      .filter((r: any) => r.publishTargets?.some((t: any) => t.type === 'npm'));
    releasePackagePaths = bumpyReleases
      .map((r: any) => path.resolve(MONOREPO_ROOT, r.dir));
  }
}

// filter out vscode extension which is not released via npm
releasePackagePaths = releasePackagePaths.filter((p: string) => !p.endsWith('packages/vscode-plugin'));

// On PRs, filter to only packages that actually changed in this PR
// plus their workspace dependencies (so preview packages can reference each other)
const isPR = !!process.env.GITHUB_HEAD_REF || !!process.env.GITHUB_BASE_REF;
if (isPR && releasePackagePaths.length > 0) {
  console.log('PR detected — filtering to packages changed in this PR + their dependencies');

  // Get files changed in this PR
  let changedFiles: Array<string>;
  try {
    changedFiles = execSync('git diff --name-only origin/main...HEAD', { cwd: MONOREPO_ROOT })
      .toString().trim().split('\n')
      .filter(Boolean);
  } catch {
    // Fallback if origin/main is not available
    changedFiles = execSync('git diff --name-only HEAD~1', { cwd: MONOREPO_ROOT })
      .toString().trim().split('\n')
      .filter(Boolean);
  }

  // Get all workspace packages
  const workspaces = await listWorkspaces(MONOREPO_ROOT);

  // Map changed files to package directories
  const changedPackagePaths = new Set<string>();
  for (const file of changedFiles) {
    const fullPath = path.resolve(MONOREPO_ROOT, file);
    for (const ws of workspaces) {
      if (fullPath.startsWith(`${ws.path}/`)) {
        changedPackagePaths.add(ws.path);
        break;
      }
    }
  }

  console.log('Packages with changes in this PR:', [...changedPackagePaths]);

  // Start with changed packages that are in the bumpy release list
  const bumpyPathSet = new Set(releasePackagePaths);
  const changedReleasable = [...changedPackagePaths].filter((p) => bumpyPathSet.has(p));

  // For those releasable packages, also include their transitive workspace
  // dependencies (so preview packages that reference each other have consistent versions)
  const workspacesByName = new Map(workspaces.map((ws) => [ws.name, ws]));

  function getWorkspaceDeps(pkgPath: string): Array<string> {
    const pkgJsonPath = path.join(pkgPath, 'package.json');
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const allDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
        ...pkgJson.peerDependencies,
      };
      return Object.entries(allDeps)
        .filter(([, version]) => typeof version === 'string' && (version as string).startsWith('workspace:'))
        .map(([name]) => workspacesByName.get(name)?.path)
        .filter((p): p is string => !!p);
    } catch {
      return [];
    }
  }

  const neededPackages = new Set<string>();
  const queue = [...changedReleasable];
  while (queue.length > 0) {
    const pkg = queue.pop()!;
    if (neededPackages.has(pkg)) continue;
    neededPackages.add(pkg);
    for (const dep of getWorkspaceDeps(pkg)) {
      if (!neededPackages.has(dep)) {
        queue.push(dep);
      }
    }
  }

  console.log('Packages needed (changed releasable + dependencies):', [...neededPackages]);

  // Intersect with bumpy's release list
  releasePackagePaths = releasePackagePaths.filter((p) => neededPackages.has(p));
}

const includesVarlock = releasePackagePaths.some((p) => p.endsWith('packages/varlock'));

console.log('Packages to release:', releasePackagePaths);
console.log('Includes varlock:', includesVarlock);

// Write to GITHUB_OUTPUT if running in CI
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  fs.appendFileSync(githubOutput, `packages=${JSON.stringify(releasePackagePaths)}\n`);
  fs.appendFileSync(githubOutput, `includes-varlock=${includesVarlock}\n`);
}
