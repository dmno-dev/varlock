import { execSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const MONOREPO_ROOT = path.resolve(path.dirname(__filename), '..');

// Accept package paths from RELEASE_PACKAGES env var (set by check-release-packages step)
const releasePackagesEnv = process.env.RELEASE_PACKAGES;
if (!releasePackagesEnv) {
  console.error('RELEASE_PACKAGES env var not set — run check-release-packages.ts first');
  process.exit(1);
}

const releasePackagePaths: Array<string> = JSON.parse(releasePackagesEnv);

if (!releasePackagePaths.length) {
  console.log('No packages to release!');
  process.exit(0);
}

let err: unknown;
try {
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
