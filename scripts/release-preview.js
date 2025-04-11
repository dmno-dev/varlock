import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readYamlFile from 'read-yaml-file';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pnpmCatalog;
async function fixPackageJsonCatalogEntries(packageJsonPath) {
  if (!pnpmCatalog) {
    const pnpmWorkspaceYaml = await readYamlFile(path.resolve(__dirname, '../pnpm-workspace.yaml'));
    pnpmCatalog = pnpmWorkspaceYaml.catalog;
  }

  const packageJsonRaw = await fs.promises.readFile(packageJsonPath, 'utf8');
  const packageJsonObj = JSON.parse(packageJsonRaw);

  for (const depObjKey of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const depObj = packageJsonObj[depObjKey];
    if (!depObj) continue;
    for (const depName of Object.keys(depObj)) {
      if (depObj[depName] === 'catalog:') {
        const catalogVersion = pnpmCatalog[depName];
        if (!catalogVersion) throw new Error(`Missing pnpm catalog version for ${depName}`);
        depObj[depName] = catalogVersion;
      } else if (depObj[depName].startsWith('catalog:')) {
        throw new Error('multiple named catalogs not supported');
      }
    }
  }

  await fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJsonObj, null, 2));
}


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

  // Temporary workaround for https://github.com/stackblitz-labs/pkg.pr.new/issues/204
  console.log('replacing pnpm `catalog:*` deps');
  for (const releasePackagePath of releasePackagePaths) {
    await fixPackageJsonCatalogEntries(path.join(releasePackagePath, 'package.json'));
  }

  const publishResult = execSync(`pnpm dlx pkg-pr-new publish --compact --pnpm ${releasePackagePaths.join(' ')}`);
  console.log('published preview packages!');
  console.log(publishResult);
} catch (_err) {
  err = _err;
  console.error('preview release failed');
  console.error(_err);
}
fs.unlinkSync('./changesets-summary.json');
process.exit(err ? 1 : 0);
