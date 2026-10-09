#!/usr/bin/env bun
/**
 * Detects which integration packages have changes, then outputs GitHub Actions
 * flags for which framework tests should run.
 *
 * On normal PRs: uses `bumpy status` to detect pending changesets.
 * On release PRs (bumpy/version-packages): uses `git diff origin/main` to find
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
  appendFileSync, existsSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { skipAlreadyPassed } from './framework-test-markers';

// Map integration test directory names to their package names.
// Dependencies are expressed by listing all triggering packages — e.g. cloudflare
// tests run when vite-integration changes because cloudflare depends on it.
const INTEGRATION_PACKAGES: Record<string, Array<string>> = {
  nextjs: ['@varlock/nextjs-integration'],
  vite: ['@varlock/vite-integration'],
  cloudflare: ['@varlock/cloudflare-integration', '@varlock/vite-integration'],
  expo: ['@varlock/expo-integration'],
  'vanilla-node': [], // no integration package — triggered only by core varlock changes
  astro: ['@varlock/astro-integration', '@varlock/vite-integration'],
  nuxt: ['@varlock/nuxt-integration', '@varlock/vite-integration'],
  'tanstack-start': ['@varlock/cloudflare-integration', '@varlock/vite-integration'],
  // SvelteKit uses the vite plugin directly; the CF scenario also pulls the
  // cloudflare integration's edge loader via auto-detection.
  sveltekit: ['@varlock/vite-integration', '@varlock/cloudflare-integration'],
};

// Quick test paths for integrations where full suite is expensive.
// When only core varlock or harness changes trigger the integration, run the quick
// path. When the integration's own package or test files change, run full suite.
const QUICK_TEST_PATHS: Record<string, string> = {
  nextjs: 'nextjs/nextjs-v16.test.ts',
};

// Full suites slow enough to split into parallel matrix jobs — each part
// becomes its own matrix entry and runs on its own runner. Next.js v15/v16 are
// further split by bundler (passed to the tests as NEXTJS_BUNDLER); v14 only
// runs webpack scenarios, so there is nothing to split.
const SPLIT_TEST_PATHS: Record<string, Record<string, { testPath: string; bundler?: string }>> = {
  nextjs: {
    v14: { testPath: 'nextjs/nextjs-v14.test.ts' },
    'v15 webpack': { testPath: 'nextjs/nextjs-v15.test.ts', bundler: 'webpack' },
    'v15 turbopack': { testPath: 'nextjs/nextjs-v15.test.ts', bundler: 'turbopack' },
    'v16 webpack': { testPath: 'nextjs/nextjs-v16.test.ts', bundler: 'webpack' },
    'v16 turbopack': { testPath: 'nextjs/nextjs-v16.test.ts', bundler: 'turbopack' },
  },
};

type IntegrationEntry = {
  name: string; integration: string; testPath: string; bundler?: string;
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

function toEntries(name: string, mode: 'full' | 'quick' = 'full'): Array<IntegrationEntry> {
  if (mode === 'quick' && QUICK_TEST_PATHS[name]) {
    return [{ name: `${name} (quick)`, integration: name, testPath: QUICK_TEST_PATHS[name] }];
  }
  if (SPLIT_TEST_PATHS[name]) {
    return Object.entries(SPLIT_TEST_PATHS[name])
      .map(([part, entry]) => ({ name: `${name} (${part})`, integration: name, ...entry }));
  }
  return [{ name, integration: name, testPath: `${name}/` }];
}

function writeResults(entries: Array<IntegrationEntry>) {
  const anyChanged = entries.length > 0;
  writeGithubOutputs({
    'any-changed': String(anyChanged),
    integrations: JSON.stringify(entries),
  });
  if (!process.env.GITHUB_OUTPUT) {
    console.log('Integrations to test:', entries.length > 0 ? entries.map((e) => e.name) : '(none)');
  }
}

// Everything except --all goes through here, so suites that already passed with
// identical inputs (see framework-test-markers.ts) are dropped from the matrix
async function finish(entries: Array<IntegrationEntry>) {
  writeResults(await skipAlreadyPassed(entries, INTEGRATION_PACKAGES));
}

// --all flag: test everything (full suite)
if (forceAll) {
  const allEntries = ALL_INTEGRATIONS.flatMap((name) => toEntries(name, 'full'));
  writeResults(await skipAlreadyPassed(allEntries, INTEGRATION_PACKAGES, { skip: false }));
  process.exit(0);
}

// Detect changed packages using the appropriate strategy
let changedPackages: Set<string>;

if (isReleasePR) {
  // On bumpy/version-packages, bumpy has already bumped versions in package.json
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
    await finish(ALL_INTEGRATIONS.flatMap((name) => toEntries(name, 'full')));
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
  // Normal PR: detect changed packages by diffing against origin/main
  console.log('Normal PR — detecting changed packages via git diff...');
  let gitDiff: string;
  try {
    execSync('git fetch origin main --depth=1', { stdio: 'pipe' });
    gitDiff = execSync('git diff origin/main --name-only', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error('Failed to diff against origin/main:', e);
    // If we can't diff, fall back to running all tests
    await finish(ALL_INTEGRATIONS.flatMap((name) => toEntries(name, 'full')));
    process.exit(0);
  }

  // Map changed files to package names by reading their package.json
  changedPackages = new Set<string>();
  const changedDirs = new Set<string>();
  for (const filePath of gitDiff.split('\n').filter(Boolean)) {
    // Extract the package directory (e.g. "packages/foo/src/bar.ts" -> "packages/foo")
    const parts = filePath.split('/');
    let pkgDir: string | undefined;
    if (parts[0] === 'packages' && parts.length >= 2) {
      // Handle packages/integrations/foo/... or packages/foo/...
      if (parts[1] === 'integrations' && parts.length >= 3) {
        pkgDir = parts.slice(0, 3).join('/');
      } else {
        pkgDir = parts.slice(0, 2).join('/');
      }
    }
    if (pkgDir && !changedDirs.has(pkgDir)) {
      changedDirs.add(pkgDir);
      const pkgJsonPath = join(REPO_ROOT, pkgDir, 'package.json');
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          if (pkg.name) changedPackages.add(pkg.name);
        } catch {
          // skip unparseable package.json
        }
      }
    }
  }
  console.log('Changed packages (from git diff):', [...changedPackages]);
}

// Changes to core varlock package trigger all integration tests on release PRs.
// On normal PRs, only core-only suites (those with no integration packages) are triggered.
if (changedPackages.has('varlock')) {
  if (isReleasePR) {
    console.log('Core varlock package changed on release PR — running all integration tests');
    await finish(ALL_INTEGRATIONS.flatMap((name) => toEntries(name, 'full')));
    process.exit(0);
  } else {
    console.log('Core varlock package changed — triggering core-only test suites');
  }
}

// Detect integrations whose test files themselves changed (git diff against base)
const changedTestIntegrations = new Set<string>();
let harnessChanged = false;
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
    } else if (filePath.startsWith('framework-tests/harness/') || filePath === 'framework-tests/vitest.config.ts') {
      // Shared test infrastructure changed — flag for all integrations
      console.log(`Shared framework test file changed (${filePath}) — will run all integration tests`);
      harnessChanged = true;
    }
  }
  if (changedTestIntegrations.size > 0) {
    console.log('Integrations with changed test files:', [...changedTestIntegrations]);
  }
} catch {
  // If git diff fails (e.g. shallow clone), we just skip this detection
}

// Match changed packages to integration test suites
const entries: Array<IntegrationEntry> = [];
for (const [name, packages] of Object.entries(INTEGRATION_PACKAGES)) {
  // Test files changed or integration package changed → full suite
  if (changedTestIntegrations.has(name) || packages.some((pkg) => changedPackages.has(pkg))) {
    entries.push(...toEntries(name, 'full'));
    continue;
  }
  // Harness changed → run all integrations, but only full if the integration's
  // own package also changed (already handled above), otherwise quick
  if (harnessChanged) {
    entries.push(...toEntries(name, 'quick'));
    continue;
  }
  // Suites with no integration packages are triggered by core varlock changes (quick)
  if (packages.length === 0 && changedPackages.has('varlock')) {
    entries.push(...toEntries(name, 'quick'));
    continue;
  }
}

await finish(entries);
