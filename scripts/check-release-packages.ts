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

if (currentBranch === 'changeset-release/main') {
  const gitDiff = execSync('git diff origin/main --name-only').toString();
  const modifiedPackageJsons = gitDiff
    .split('\n')
    .filter((filePath) => filePath !== 'package.json')
    .filter((filePath) => filePath.endsWith('package.json'));

  releasePackagePaths = modifiedPackageJsons
    .map((filePath) => `${MONOREPO_ROOT}/${filePath.replace('/package.json', '')}`)
    .filter((filePath) => workspacePackagesInfo.some((p) => p.path === filePath));
} else {
  execSync('bunx changeset status --output=changesets-summary.json', { cwd: MONOREPO_ROOT });

  const changeSetsSummaryRaw = fs.readFileSync(path.join(MONOREPO_ROOT, 'changesets-summary.json'), 'utf8');
  const changeSetsSummary = JSON.parse(changeSetsSummaryRaw);

  releasePackagePaths = changeSetsSummary.releases
    .filter((r: any) => r.newVersion !== r.oldVersion)
    .map((r: any) => workspacePackagesInfo.find((p) => p.name === r.name))
    .filter(Boolean)
    .map((p: any) => p.path);

  fs.unlinkSync(path.join(MONOREPO_ROOT, 'changesets-summary.json'));
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
