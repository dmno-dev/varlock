import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const MONOREPO_ROOT = path.resolve(path.dirname(__filename), '..');

let err;
try {
  const workspacePackagesInfoRaw = execSync('pnpm m ls --json --depth=-1');
  const workspacePackagesInfo = JSON.parse(workspacePackagesInfoRaw);

  // Check if we're on changeset-release/main branch
  const currentBranch = process.env.GITHUB_HEAD_REF || execSync('git branch --show-current').toString().trim();
  let releasePackagePaths;

  console.log('current branch = ', currentBranch);

  if (currentBranch === 'changeset-release/main') {
    // On changeset-release/main branch, find modified package.json files
    console.log('Running on changeset-release/main branch, finding modified package.json files...');
    const gitDiff = execSync('git diff origin/main --name-only').toString();
    const modifiedPackageJsons = gitDiff
      .split('\n')
      .filter((filePath) => filePath !== 'package.json') // skip root package.json
      .filter((filePath) => filePath.endsWith('package.json'));

    if (!modifiedPackageJsons.length) {
      console.log('No modified package.json files found!');
      process.exit(0);
    }

    // Get the workspace paths for modified packages
    releasePackagePaths = modifiedPackageJsons
      .map((filePath) => `${MONOREPO_ROOT}/${filePath.replace('/package.json', '')}`)
      .filter((filePath) => workspacePackagesInfo.some((p) => p.path === filePath));
  } else {
    console.log('Running on normal PR, using changesets to determine packages to release...');
    // Regular changeset-based logic
    // generate summary of changed (publishable) modules according to changesets
    execSync('pnpm exec changeset status --output=changesets-summary.json');

    const changeSetsSummaryRaw = fs.readFileSync('./changesets-summary.json', 'utf8');
    const changeSetsSummary = JSON.parse(changeSetsSummaryRaw);

    releasePackagePaths = changeSetsSummary.releases
      .filter((r) => r.newVersion !== r.oldVersion)
      .map((r) => workspacePackagesInfo.find((p) => p.name === r.name))
      .map((p) => p.path);
  }

  // filter out vscode extension which is not released via npm
  releasePackagePaths = releasePackagePaths.filter((p) => !p.endsWith('packages/vscode-plugin'));

  if (!releasePackagePaths.length) {
    console.log('No packages to release!');
    process.exit(0);
  }

  console.log('Updated packages to release:', releasePackagePaths);

  const publishResult = execSync(`pnpm dlx pkg-pr-new publish --pnpm ${releasePackagePaths.join(' ')}`);
  console.log('published preview packages!');
  console.log(publishResult);
} catch (_err) {
  err = _err;
  console.error('preview release failed');
  console.error(_err);
}

// Only clean up changesets-summary.json if it exists (only created in changeset case)
if (fs.existsSync('./changesets-summary.json')) {
  fs.unlinkSync('./changesets-summary.json');
}
process.exit(err ? 1 : 0);
