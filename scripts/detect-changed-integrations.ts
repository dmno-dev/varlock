#!/usr/bin/env bun
/**
 * Detects which integration packages have changes, then outputs GitHub Actions
 * flags for which framework tests should run.
 *
 * On normal PRs: uses `changeset status` to detect pending changesets.
 * On release PRs (changeset-release/main): uses `git diff origin/main` to find
 * modified package.json files — same approach as release-preview.ts.
 *
 * When the core `varlock` package changes, all integration tests are triggered
 * only on release PRs since core changes are frequent and framework tests are slow.
 *
 * To add a new integration, add an entry to INTEGRATION_PACKAGES below
 * and create the corresponding test directory in framework-tests/frameworks/.
 */
import { execSync } from 'node:child_process';
import {
  appendFileSync, existsSync, readFileSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

// Map integration test directory names to their package names.
// Dependencies are expressed by listing all triggering packages — e.g. cloudflare
// tests run when vite-integration changes because cloudflare depends on it.
const INTEGRATION_PACKAGES: Record<string, Array<string>> = {
  nextjs: ['@varlock/nextjs-integration'],
  vite: ['@varlock/vite-integration'],
  cloudflare: ['@varlock/cloudflare-integration', '@varlock/vite-integration'],
  expo: ['@varlock/expo-integration'],
  'vanilla-node': [], // no integration package — triggered only by core varlock changes
  // astro: ['@varlock/astro-integration', '@varlock/vite-integration'],
};

const ALL_INTEGRATIONS = Object.keys(INTEGRATION_PACKAGES);
const forceAll = process.argv.includes('--all');
const isReleasePR = process.argv.includes('--release-pr');

function writeGithubOutputs(outputs: Record<string, string>) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

const REPO_ROOT = join(import.meta.dirname, '..');
const STATUS_FILE = 'changesets-summary.json';
const statusFilePath = join(REPO_ROOT, STATUS_FILE);

function writeResults(integrations: Array<string>) {
  const anyChanged = integrations.length > 0;
  writeGithubOutputs({
    'any-changed': String(anyChanged),
    integrations: JSON.stringify(integrations),
  });
  if (!process.env.GITHUB_OUTPUT) {
    console.log('Integrations to test:', integrations.length > 0 ? integrations : '(none)');
  }
}

// --all flag: test everything
if (forceAll) {
  writeResults(ALL_INTEGRATIONS);
  process.exit(0);
}

// Detect changed packages using the appropriate strategy
let changedPackages: Set<string>;

if (isReleasePR) {
  // On changeset-release/main, changesets has already bumped versions in package.json
  // files. Detect which packages changed by diffing package.json files vs origin/main,
  // same approach as release-preview.ts.
  console.log('Release PR detected — finding modified package.json files vs origin/main...');
  let gitDiff: string;
  try {
    execSync('git fetch origin main --depth=1', { stdio: 'pipe' });
    gitDiff = execSync('git diff origin/main --name-only', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error('Failed to diff against origin/main:', e);
    writeResults(ALL_INTEGRATIONS);
    process.exit(0);
  }

  const modifiedPackageJsons = gitDiff
    .split('\n')
    .filter((filePath) => filePath !== 'package.json') // skip root package.json
    .filter((filePath) => filePath.endsWith('package.json'));

  // Read each modified package.json to get the package name
  changedPackages = new Set<string>();
  for (const pkgJsonPath of modifiedPackageJsons) {
    const fullPath = join(REPO_ROOT, pkgJsonPath);
    if (!existsSync(fullPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(fullPath, 'utf-8'));
      if (pkg.name) changedPackages.add(pkg.name);
    } catch {
      // skip unparseable package.json
    }
  }
  console.log('Changed packages (from modified package.json):', [...changedPackages]);
} else {
  // Normal PR: use changeset CLI to get pending changesets
  try {
    execSync(`bunx changeset status --output=${STATUS_FILE}`, {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  } catch {
    // changeset status can fail when there are no changesets or no base branch
  }

  if (!existsSync(statusFilePath)) {
    console.log('No changesets found');
    // Don't exit — test files themselves may have changed (detected below)
    changedPackages = new Set<string>();
  } else {
    let status: any;
    try {
      status = JSON.parse(readFileSync(statusFilePath, 'utf-8'));
    } finally {
      unlinkSync(statusFilePath);
    }

    changedPackages = new Set<string>(
      status.releases
        ?.filter((r: { type: string }) => r.type !== 'none')
        .map((r: { name: string }) => r.name) ?? [],
    );
    if (!process.env.GITHUB_OUTPUT) {
      console.log('Changed packages (from changesets):', [...changedPackages]);
    }
  }
}

// Changes to core varlock package trigger all integration tests on release PRs.
// On normal PRs, only core-only suites (those with no integration packages) are triggered.
if (changedPackages.has('varlock')) {
  if (isReleasePR) {
    console.log('Core varlock package changed on release PR — running all integration tests');
    writeResults(ALL_INTEGRATIONS);
    process.exit(0);
  } else {
    console.log('Core varlock package changed — triggering core-only test suites');
  }
}

// Detect integrations whose test files themselves changed (git diff against base)
const changedTestIntegrations = new Set<string>();
try {
  execSync('git fetch origin main --depth=1', { stdio: 'pipe' });
  const diffOutput = execSync('git diff origin/main --name-only -- framework-tests/', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  for (const filePath of diffOutput.split('\n').filter(Boolean)) {
    // Match paths like framework-tests/frameworks/<name>/... or shared test files
    const match = filePath.match(/^framework-tests\/frameworks\/([^/]+)\//);
    if (match && ALL_INTEGRATIONS.includes(match[1])) {
      changedTestIntegrations.add(match[1]);
    } else if (filePath.startsWith('framework-tests/') && !filePath.startsWith('framework-tests/frameworks/')) {
      // Shared test infrastructure changed — trigger all
      console.log(`Shared framework test file changed (${filePath}) — running all integration tests`);
      writeResults(ALL_INTEGRATIONS);
      process.exit(0);
    }
  }
  if (changedTestIntegrations.size > 0) {
    console.log('Integrations with changed test files:', [...changedTestIntegrations]);
  }
} catch {
  // If git diff fails (e.g. shallow clone), we just skip this detection
}

// Match changed packages to integration test suites
const integrationsList = Object.entries(INTEGRATION_PACKAGES)
  .filter(([name, packages]) => {
    // triggered if the test files themselves changed
    if (changedTestIntegrations.has(name)) return true;
    // suites with no integration packages are triggered by core varlock changes
    if (packages.length === 0) return changedPackages.has('varlock');
    return packages.some((pkg) => changedPackages.has(pkg));
  })
  .map(([name]) => name);

writeResults(integrationsList);
