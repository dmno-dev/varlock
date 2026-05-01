/**
 * Determines which packages would be published in a preview release.
 *
 * Uses `bumpy status --json` to find packages with pending changesets.
 * On PRs, filters to only packages bumped in the current branch
 * (using bumpy's `inCurrentBranch` flag) plus their workspace dependencies.
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
    const isPR = !!process.env.GITHUB_HEAD_REF || !!process.env.GITHUB_BASE_REF;

    let bumpyReleases = bumpyStatus.releases
      .filter((r: any) => r.publishTargets?.some((t: any) => t.type === 'npm'));

    if (isPR) {
      // On PRs, only include packages bumped in the current branch
      // (ignore pending bumps already on main that aren't part of this PR)
      console.log('PR detected — filtering to packages bumped in this branch');
      const branchReleases = bumpyReleases.filter((r: any) => r.inCurrentBranch);
      const branchReleasePaths = branchReleases
        .map((r: any) => path.resolve(MONOREPO_ROOT, r.dir));

      // Also include transitive workspace dependencies of bumped packages
      // (so preview packages that reference each other have consistent versions)
      const workspaces = await listWorkspaces(MONOREPO_ROOT);
      const workspacesByName = new Map(workspaces.map((ws) => [ws.name, ws]));
      const allReleasePaths = new Set(bumpyReleases.map((r: any) => path.resolve(MONOREPO_ROOT, r.dir)));

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
      const queue = [...branchReleasePaths];
      while (queue.length > 0) {
        const pkg = queue.pop()!;
        if (neededPackages.has(pkg)) continue;
        neededPackages.add(pkg);
        for (const dep of getWorkspaceDeps(pkg)) {
          // Only include deps that bumpy also wants to release
          if (!neededPackages.has(dep) && allReleasePaths.has(dep)) {
            queue.push(dep);
          }
        }
      }

      releasePackagePaths = [...neededPackages];
      console.log('Packages bumped in this branch:', branchReleasePaths);
      console.log('Packages to preview (+ dependencies):', releasePackagePaths);
    } else {
      releasePackagePaths = bumpyReleases
        .map((r: any) => path.resolve(MONOREPO_ROOT, r.dir));
    }
  }
}

// filter out vscode extension which is not released via npm
releasePackagePaths = releasePackagePaths.filter((p: string) => !p.endsWith('packages/vscode-plugin'));

const includesVarlock = releasePackagePaths.some((p) => p.endsWith('packages/varlock'));

console.log('Packages to release:', releasePackagePaths);
console.log('Includes varlock:', includesVarlock);

// Write to GITHUB_OUTPUT if running in CI
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  fs.appendFileSync(githubOutput, `packages=${JSON.stringify(releasePackagePaths)}\n`);
  fs.appendFileSync(githubOutput, `includes-varlock=${includesVarlock}\n`);
}
