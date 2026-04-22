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
    // On a normal PR, use bumpy status to determine which packages would be released.
    // This includes pending bump files from main (merged into the branch), so preview
    // releases will be published for all pending packages — not just those changed in the PR.
    // This ensures preview packages that reference each other have consistent versions.
    console.log('Running on normal PR, using bumpy to determine packages to release...');

    let bumpyStatusRaw: string;
    try {
      bumpyStatusRaw = execSync('bunx @varlock/bumpy status --json 2>/dev/null').toString();
    } catch (execErr: any) {
      // bumpy may exit non-zero with warnings (e.g. unknown bump types) but still output valid JSON
      bumpyStatusRaw = execErr.stdout?.toString() ?? '';
      if (bumpyStatusRaw) {
        console.warn('bumpy status exited with warnings, attempting to parse output...');
      } else {
        throw execErr;
      }
    }

    // stdout may contain warning lines before the JSON — extract just the JSON
    const jsonMatch = bumpyStatusRaw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('No JSON output from bumpy status');
      process.exit(0);
    }
    const bumpyStatus = JSON.parse(jsonMatch[0]);

    // Filter to only packages that publish to npm (using publishTargets from bumpy 1.2+)
    releasePackagePaths = bumpyStatus.releases
      .filter((r: any) => r.publishTargets?.includes('npm'))
      .map((r: any) => workspacePackagesInfo.find((p) => p.name === r.name))
      .filter(Boolean)
      .map((p: any) => p.path);
  }

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
} catch (_err: any) {
  err = _err;
  console.error('::error::Preview release failed');
  // Print a clean error message for GitHub Actions instead of the full stack trace
  if (_err.message) console.error(_err.message);
  if (_err.stderr?.toString().trim()) console.error(_err.stderr.toString());
}

process.exit(err ? 1 : 0);
