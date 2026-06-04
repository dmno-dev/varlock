/**
 * Initialize a brand-new npm package by publishing a minimal placeholder.
 *
 * npm's trusted publishing flow requires the package to already exist on the
 * registry before you can configure the OIDC trusted publisher mapping. This
 * script handles that bootstrap step:
 *
 *   1. Finds the target package's package.json in the workspace
 *   2. Trims it down to a publishable placeholder (no deps, no build)
 *   3. Publishes from a temp directory using your local npm session
 *   4. Prints the next-step instructions for configuring trusted publishing
 *
 * After the placeholder is up, configure trusted publishing on npmjs.com so
 * subsequent releases publish from CI via OIDC with no token needed.
 *
 * Usage:
 *   bun run scripts/init-new-package.ts <package-path-or-name> [--dry-run]
 *
 * Examples:
 *   bun run scripts/init-new-package.ts packages/plugins/kubernetes
 *   bun run scripts/init-new-package.ts @varlock/kubernetes-plugin
 *   bun run scripts/init-new-package.ts packages/plugins/kubernetes --dry-run
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listWorkspaces } from './list-workspaces';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Configurable: the GitHub repo + workflow CI uses to publish.
// These are echoed back at the end as part of the trusted-publisher setup steps.
const TRUSTED_PUBLISHER = {
  repo: 'dmno-dev/varlock',
  workflow: 'release.yaml',
};

const PLACEHOLDER_VERSION = '0.0.0';

// Fields we keep from the real package.json — everything else is dropped so the
// placeholder doesn't need a build step or workspace deps to publish.
const FIELDS_TO_KEEP = [
  'name',
  'description',
  'homepage',
  'bugs',
  'repository',
  'keywords',
  'author',
  'license',
  'engines',
] as const;

function fail(msg: string): never {
  console.error(`\nerror: ${msg}`);
  process.exit(1);
}

async function resolvePackage(arg: string) {
  // Try as a relative or absolute path first
  const asPath = path.isAbsolute(arg) ? arg : path.resolve(REPO_ROOT, arg);
  try {
    const text = await fs.readFile(path.join(asPath, 'package.json'), 'utf-8');
    return { dir: asPath, pkg: JSON.parse(text) };
  } catch { /* fall through to name lookup */ }

  // Otherwise look it up by name in the workspaces
  const workspaces = await listWorkspaces(REPO_ROOT);
  const match = workspaces.find((w) => w.name === arg);
  if (!match) fail(`could not find package "${arg}" — pass a workspace path or a package name`);
  const text = await fs.readFile(path.join(match.path, 'package.json'), 'utf-8');
  return { dir: match.path, pkg: JSON.parse(text) };
}

function buildPlaceholderPackageJson(realPkg: Record<string, unknown>) {
  const placeholder: Record<string, unknown> = {};
  for (const field of FIELDS_TO_KEEP) {
    if (realPkg[field] !== undefined) placeholder[field] = realPkg[field];
  }
  placeholder.version = PLACEHOLDER_VERSION;
  placeholder.main = 'index.js';
  // Scoped packages default to private — make sure the placeholder is public.
  placeholder.publishConfig = { access: 'public' };
  return placeholder;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const arg = args.find((a) => !a.startsWith('--'));
if (!arg) fail('usage: bun run scripts/init-new-package.ts <package-path-or-name> [--dry-run]');

const { dir, pkg } = await resolvePackage(arg);
const pkgName = pkg.name as string;
console.log(`📦 Target: ${pkgName}`);
console.log(`   Source: ${path.relative(REPO_ROOT, dir)}/package.json`);

// Refuse to re-publish a package that already exists
const view = spawnSync('npm', ['view', pkgName, 'version'], { encoding: 'utf-8' });
if (view.status === 0 && view.stdout.trim()) {
  fail(
    `${pkgName}@${view.stdout.trim()} is already on npm — use the regular `
    + 'release flow (bumpy + CI) for subsequent versions',
  );
}

// Verify the user is logged in (the publish needs a session)
if (!dryRun) {
  const whoami = spawnSync('npm', ['whoami'], { encoding: 'utf-8' });
  if (whoami.status !== 0) fail('not logged in to npm — run `npm login` first');
  console.log(`   npm user: ${whoami.stdout.trim()}`);
}

// Build + write the placeholder into a temp dir
const placeholder = buildPlaceholderPackageJson(pkg);
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varlock-pkg-init-'));
console.log(`\n📂 Placeholder: ${tmpDir}`);

await fs.writeFile(
  path.join(tmpDir, 'package.json'),
  `${JSON.stringify(placeholder, null, 2)}\n`,
);
await fs.writeFile(
  path.join(tmpDir, 'index.js'),
  `// Placeholder for the initial npm publish of ${pkgName}.\n`
  + '// The real package will be released through CI shortly.\n',
);
await fs.writeFile(
  path.join(tmpDir, 'README.md'),
  `# ${pkgName}\n\n`
  + `Placeholder for the initial npm publish (\`${PLACEHOLDER_VERSION}\`). `
  + 'The real package will be released through CI shortly.\n',
);

console.log('\n--- placeholder package.json ---');
console.log(JSON.stringify(placeholder, null, 2));
console.log('--------------------------------');

if (dryRun) {
  console.log(`\n[dry-run] Skipping publish. Placeholder files at: ${tmpDir}`);
  process.exit(0);
}

console.log('\n▶ Running `npm publish --access public`');
const publish = spawnSync('npm', ['publish', '--access', 'public'], {
  cwd: tmpDir,
  stdio: 'inherit',
});
if (publish.status !== 0) {
  console.error(`\nnpm publish failed (exit code ${publish.status}).`);
  console.error(`Temp dir kept for inspection: ${tmpDir}`);
  process.exit(publish.status ?? 1);
}

await fs.rm(tmpDir, { recursive: true, force: true });

const accessUrl = `https://www.npmjs.com/package/${pkgName}/access`;
console.log(`
Published ${pkgName}@${PLACEHOLDER_VERSION} as a placeholder.

Next: configure trusted publishing so future releases run via CI's OIDC
identity (no npm token needed).

   1. Visit:  ${accessUrl}
   2. Scroll to "Trusted Publisher" → "Add Trusted Publisher"
   3. Choose GitHub Actions and fill in:
        Organization or user:  ${TRUSTED_PUBLISHER.repo.split('/')[0]}
        Repository:            ${TRUSTED_PUBLISHER.repo.split('/')[1]}
        Workflow filename:     ${TRUSTED_PUBLISHER.workflow}
        Environment name:      (leave blank)
   4. Save.

After that, push to main as usual — bumpy + the release workflow will publish
the real version via OIDC.
`);
