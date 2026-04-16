import { execSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspaces } from './list-workspaces';

const __filename = fileURLToPath(import.meta.url);
const MONOREPO_ROOT = path.resolve(path.dirname(__filename), '..');

let err: unknown;
try {
  const workspacePackagesInfo = await listWorkspaces(MONOREPO_ROOT);

  // Check if we're on bumpy version branch
  const currentBranch = process.env.GITHUB_HEAD_REF || execSync('git branch --show-current').toString().trim();
  let releasePackagePaths: Array<string>;

  console.log('current branch = ', currentBranch);

  if (currentBranch === 'bumpy/version-packages') {
    // On bumpy version branch, find modified package.json files
    console.log('Running on bumpy/version-packages branch, finding modified package.json files...');
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
    console.log('Running on normal PR, using bumpy to determine packages to release...');
    // Use bumpy status to determine which packages would be released
    const bumpyStatusRaw = execSync('bunx @varlock/bumpy status --json 2>/dev/null').toString();
    const bumpyStatus = JSON.parse(bumpyStatusRaw);

    releasePackagePaths = bumpyStatus.releases
      .map((r: any) => workspacePackagesInfo.find((p) => p.name === r.name))
      .filter(Boolean)
      .map((p: any) => p.path);
  }

  // filter out vscode extension which is not released via npm
  releasePackagePaths = releasePackagePaths.filter((p: string) => !p.endsWith('packages/vscode-plugin'));

  if (!releasePackagePaths.length) {
    console.log('No packages to release!');
    process.exit(0);
  }

  console.log('Updated packages to release:', releasePackagePaths);

  // Resolve workspace: and catalog: protocols in package.json files before publishing
  // (npm/pkg-pr-new don't understand these protocols, so we need real versions)
  console.log('Resolving workspace/catalog versions...');
  execSync('bun run scripts/resolve-workspace-versions.ts', { stdio: 'inherit', cwd: MONOREPO_ROOT });

  const publishResult = execFileSync('bunx', ['pkg-pr-new', 'publish', ...releasePackagePaths]);
  console.log('published preview packages!');
  console.log(publishResult.toString());
} catch (_err) {
  err = _err;
  console.error('preview release failed');
  console.error(_err);
}

process.exit(err ? 1 : 0);
