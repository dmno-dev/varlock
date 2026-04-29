/**
 * Determines which packages would be published in a preview release.
 * Outputs a JSON array of package paths and a flag for whether varlock is included.
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

const workspacePackagesInfo = await listWorkspaces(MONOREPO_ROOT);

const currentBranch = process.env.GITHUB_HEAD_REF || execSync('git branch --show-current').toString().trim();
let releasePackagePaths: Array<string>;

if (currentBranch === 'bumpy/version-packages') {
  // On bumpy version branch, find modified package.json files
  const gitDiff = execSync('git diff origin/main --name-only').toString();
  const modifiedPackageJsons = gitDiff
    .split('\n')
    .filter((filePath) => filePath !== 'package.json')
    .filter((filePath) => filePath.endsWith('package.json'));

  releasePackagePaths = modifiedPackageJsons
    .map((filePath) => `${MONOREPO_ROOT}/${filePath.replace('/package.json', '')}`)
    .filter((filePath) => workspacePackagesInfo.some((p) => p.path === filePath));
} else {
  // Normal PR: use bumpy status to determine which packages have pending changesets
  let bumpyStatusRaw: string;
  try {
    bumpyStatusRaw = execSync('bunx @varlock/bumpy status --json 2>/dev/null', { cwd: MONOREPO_ROOT }).toString();
  } catch (execErr: any) {
    // bumpy may exit non-zero with warnings but still output valid JSON
    bumpyStatusRaw = execErr.stdout?.toString() ?? '';
    if (!bumpyStatusRaw) {
      console.log('No pending changesets found');
      releasePackagePaths = [];
    }
  }

  if (bumpyStatusRaw!) {
    // stdout may contain warning lines before the JSON — extract just the JSON
    const jsonMatch = bumpyStatusRaw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('No JSON output from bumpy status');
      releasePackagePaths = [];
    } else {
      const bumpyStatus = JSON.parse(jsonMatch[0]);
      releasePackagePaths = bumpyStatus.releases
        .filter((r: any) => r.publishTargets?.includes('npm'))
        .map((r: any) => workspacePackagesInfo.find((p) => p.name === r.name))
        .filter(Boolean)
        .map((p: any) => p.path);
    }
  }
}

// filter out vscode extension which is not released via npm
releasePackagePaths = releasePackagePaths!.filter((p: string) => !p.endsWith('packages/vscode-plugin'));

const includesVarlock = releasePackagePaths.some((p) => p.endsWith('packages/varlock'));

console.log('Packages to release:', releasePackagePaths);
console.log('Includes varlock:', includesVarlock);

// Write to GITHUB_OUTPUT if running in CI
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  fs.appendFileSync(githubOutput, `packages=${JSON.stringify(releasePackagePaths)}\n`);
  fs.appendFileSync(githubOutput, `includes-varlock=${includesVarlock}\n`);
}
