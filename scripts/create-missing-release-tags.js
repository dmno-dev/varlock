import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const MONOREPO_ROOT = path.resolve(path.dirname(__filename), '..');

const dryRun = process.argv.includes('--dry-run');

if (dryRun) console.log('=== DRY RUN MODE ===\n');

// Get all workspace packages
const workspacePackagesInfoRaw = execSync('pnpm m ls --json --depth=-1', { cwd: MONOREPO_ROOT });
const workspacePackagesInfo = JSON.parse(workspacePackagesInfoRaw);

// Get existing git tags
const existingTags = new Set(
  execSync('git tag -l', { cwd: MONOREPO_ROOT }).toString().trim().split('\n'),
);

// Get all publishable (non-private) packages
const publishablePackages = workspacePackagesInfo.filter((pkg) => {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkg.path, 'package.json'), 'utf-8'));
  return !pkgJson.private;
});

/**
 * Extract the changelog section for a specific version from CHANGELOG.md
 */
function getChangelogSection(pkgPath, version) {
  const changelogPath = path.join(pkgPath, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return '';

  const changelog = fs.readFileSync(changelogPath, 'utf-8');
  // Match the section between `## {version}` and the next `## ` (or end of file)
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRegex = new RegExp(`^## ${escapedVersion}\\s*\\n(.*?)(?=^## |\\Z)`, 'ms');
  const match = changelog.match(sectionRegex);
  return match ? match[1].trim() : '';
}

const missingReleases = [];

for (const pkg of publishablePackages) {
  const tag = `${pkg.name}@${pkg.version}`;
  if (!existingTags.has(tag)) {
    missingReleases.push({ ...pkg, tag });
  }
}

if (missingReleases.length === 0) {
  console.log('All packages have their release tags. Nothing to do!');
  process.exit(0);
}

console.log(`Found ${missingReleases.length} missing release tag(s):\n`);
for (const pkg of missingReleases) {
  console.log(`  ${pkg.tag}`);
}
console.log();

for (const pkg of missingReleases) {
  const releaseNotes = getChangelogSection(pkg.path, pkg.version);

  if (dryRun) {
    console.log(`[dry-run] Would create tag: ${pkg.tag}`);
    console.log(`[dry-run] Would create GitHub release: ${pkg.tag}`);
    if (releaseNotes) {
      console.log(`[dry-run] Release notes:\n${releaseNotes}\n`);
    } else {
      console.log('[dry-run] No changelog entry found\n');
    }
    continue;
  }

  // Create GitHub release (this also creates the git tag on the remote)
  console.log(`Creating GitHub release: ${pkg.tag}`);
  const ghArgs = [
    'release',
    'create',
    pkg.tag,
    '--title',
    pkg.tag,
  ];
  if (releaseNotes) {
    ghArgs.push('--notes-file', '-');
  } else {
    ghArgs.push('--notes', '');
  }

  execFileSync('gh', ghArgs, {
    cwd: MONOREPO_ROOT,
    input: releaseNotes || undefined,
    stdio: releaseNotes ? ['pipe', 'inherit', 'inherit'] : ['ignore', 'inherit', 'inherit'],
  });

  console.log('  Done!\n');
}

console.log('\nFinished!');
