import { execSync } from 'node:child_process';
import fs from 'node:fs';

let err;
try {
  const workspacePackagesInfoRaw = execSync('pnpm m ls --json --depth=-1');
  const workspacePackagesInfo = JSON.parse(workspacePackagesInfoRaw);

  // generate summary of changed (publishable) modules according to changesets
  // only has option to output to a file
  execSync('pnpm exec changeset status --output=changesets-summary.json');

  const changeSetsSummaryRaw = fs.readFileSync('./changesets-summary.json', 'utf8');
  const changeSetsSummary = JSON.parse(changeSetsSummaryRaw);
  // console.log(changeSetsSummary);

  if (!changeSetsSummary.releases.length) {
    console.log('No preview packages to release!');
    process.exit(0);
  }

  const releasePackagePaths = changeSetsSummary.releases
    .filter((r) => r.newVersion !== r.oldVersion)
    .map((r) => workspacePackagesInfo.find((p) => p.name === r.name))
    .map((p) => p.path);

  // TODO: put back --compact once repo is public?
  const publishResult = execSync(`pnpm dlx pkg-pr-new publish --pnpm ${releasePackagePaths.join(' ')}`);
  console.log('published preview packages!');
  console.log(publishResult);
} catch (_err) {
  err = _err;
  console.error('preview release failed');
  console.error(_err);
}
fs.unlinkSync('./changesets-summary.json');
process.exit(err ? 1 : 0);
