/**
 * Skips framework test suites that already passed with identical inputs.
 *
 * Each suite gets a fingerprint built from:
 * - turbo's build hash of `varlock` and the suite's integration packages. Turbo
 *   only hashes build inputs (src, config) and folds in each package's workspace
 *   deps, so docs edits don't change it and core changes reach every suite.
 * - git tree hashes of committed files those packages publish that aren't build
 *   inputs (e.g. `bin/` wrappers), since the tests install the packed packages
 * - git tree hashes of the suite's test files and the shared test infrastructure
 * - the matrix entry itself (test path, bundler)
 *
 * When a suite passes, the framework-tests workflow uploads a tiny artifact named
 * `fw-pass-<fingerprint>`. Artifacts (unlike the Actions cache, which Depot
 * runners redirect to Depot Cache) always land in GitHub, and the REST API finds
 * them across all branches, so a pass on a feature PR also counts on the release
 * PR. Markers from fork PR runs are ignored (a fork PR runs its own workflow
 * files, so it could upload a marker without running anything), and markers
 * expire after MARKER_MAX_AGE_DAYS so suites still run periodically against new
 * upstream framework releases.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MARKER_PREFIX = 'fw-pass-';
const MARKER_MAX_AGE_DAYS = 7;

const REPO_ROOT = join(import.meta.dirname, '..');

// Inputs shared by every suite, plus the suite's own folder (added per suite)
const SHARED_INPUT_PATHS = [
  'framework-tests/harness',
  'framework-tests/vitest.config.ts',
  'framework-tests/package.json',
  'framework-tests/bun.lock',
  '.github/workflows/framework-tests.yaml',
];

type Entry = { name: string; integration: string; testPath: string; bundler?: string };

function getTurboVersion(): string {
  // Run the version pinned in the lockfile so hashes don't shift with turbo releases
  const match = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf-8').match(/"turbo": \["turbo@([^"]+)"/);
  if (!match) throw new Error('Could not find turbo version in bun.lock');
  return match[1];
}

type TurboTask = { hash: string; directory: string };

function getTurboBuildTasks(): Record<string, TurboTask> {
  // No install needed: a dry run only reads package.json files, the lockfile and git
  const json = execSync(`bunx turbo@${getTurboVersion()} run build --dry=json`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const tasks: Array<TurboTask & { package: string }> = JSON.parse(json).tasks;
  return Object.fromEntries(tasks.map((t) => [t.package, { hash: t.hash, directory: t.directory }]));
}

function gitTreeHash(path: string): string {
  return execSync(`git rev-parse HEAD:${path}`, { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// `files` entries that are committed (bin/, skills/, ...) get packed and run by
// the tests without being turbo build inputs. Build outputs like dist/ aren't
// committed, so they're skipped here and covered by the turbo hash instead.
function publishedSourceHashes(directory: string): Array<string> {
  const { files = [] } = JSON.parse(readFileSync(join(REPO_ROOT, directory, 'package.json'), 'utf-8'));
  return (files as Array<string>).flatMap((entry) => {
    const rel = entry.replace(/^\//, '').replace(/\/$/, '');
    // a glob could match anything in the package, so hash the whole package
    const path = /[*?[]/.test(rel) ? directory : `${directory}/${rel}`;
    try {
      return [`${path}=${gitTreeHash(path)}`];
    } catch {
      return [];
    }
  });
}

function fingerprint(entry: Entry, packages: Array<string>, turboTasks: Record<string, TurboTask>): string {
  const parts = [JSON.stringify(entry)];
  for (const pkg of ['varlock', ...packages]) {
    const task = turboTasks[pkg];
    if (!task) throw new Error(`No turbo build hash for ${pkg}`);
    parts.push(`${pkg}=${task.hash}`, ...publishedSourceHashes(task.directory));
  }
  for (const path of [...SHARED_INPUT_PATHS, `framework-tests/frameworks/${entry.integration}`]) {
    parts.push(`${path}=${gitTreeHash(path)}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
}

async function githubGet(path: string): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

type MarkerArtifact = {
  expired: boolean;
  created_at: string;
  workflow_run: { head_branch: string; head_repository_id: number; repository_id: number };
};

// Returns the branch a trusted, unexpired marker came from, if any. A marker is
// trusted only if the run's code came from this repo (fork PR runs have the
// fork as their head repository).
async function findPassMarker(fingerprintValue: string, minCreatedAt: number): Promise<string | undefined> {
  const name = `${MARKER_PREFIX}${fingerprintValue}`;
  const { artifacts } = await githubGet(`/actions/artifacts?name=${name}&per_page=50`);
  const trusted = (artifacts as Array<MarkerArtifact>).find((a) => !a.expired
    && Date.parse(a.created_at) >= minCreatedAt
    && a.workflow_run.head_repository_id === a.workflow_run.repository_id);
  return trusted?.workflow_run.head_branch;
}

/**
 * Adds a `fingerprint` to each entry and drops entries with a trusted, recent
 * pass marker. Any failure falls back to running every entry.
 */
export async function skipAlreadyPassed<T extends Entry>(
  entries: Array<T>,
  integrationPackages: Record<string, Array<string>>,
  // false = only add fingerprints (forced runs still record markers)
  opts: { skip?: boolean } = {},
): Promise<Array<T & { fingerprint?: string }>> {
  if (entries.length === 0) return entries;
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) {
    console.log('No GitHub token/repo (local run?) - not checking pass markers');
    return entries;
  }
  try {
    const turboTasks = getTurboBuildTasks();
    const withFingerprints = entries.map((entry) => ({
      ...entry,
      fingerprint: fingerprint(entry, integrationPackages[entry.integration] ?? [], turboTasks),
    }));

    if (opts.skip === false) return withFingerprints;

    const minCreatedAt = Date.now() - MARKER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const passedOn = await Promise.all(withFingerprints.map((e) => findPassMarker(e.fingerprint, minCreatedAt)));

    const toRun: typeof withFingerprints = [];
    withFingerprints.forEach((entry, i) => {
      if (passedOn[i]) {
        console.log(`Skipping ${entry.name}: already passed with identical inputs (on ${passedOn[i]})`);
      } else {
        toRun.push(entry);
      }
    });
    return toRun;
  } catch (err) {
    console.error('Pass marker check failed, running all selected suites:', err);
    return entries;
  }
}
