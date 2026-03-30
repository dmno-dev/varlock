#!/usr/bin/env bun
/**
 * Uses `changeset status` to detect which integration packages have pending changes,
 * then outputs GitHub Actions flags for which framework tests should run.
 *
 * To add a new integration, add an entry to INTEGRATION_PACKAGES below
 * and create the corresponding test directory in framework-tests/frameworks/.
 */
import { execSync } from 'node:child_process';
import {
  appendFileSync, existsSync, readFileSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

// Map integration test directory names to their package names in changesets.
// Add new integrations here as they are created.
// Changes to `varlock` (core) trigger all integration tests.
const INTEGRATION_PACKAGES: Record<string, Array<string>> = {
  nextjs: ['@varlock/nextjs-integration'],
  cloudflare: ['@varlock/cloudflare-integration', '@varlock/vite-integration'],
  expo: ['@varlock/expo-integration'],
  // astro: ['@varlock/astro-integration'],
};

const ALL_INTEGRATIONS = Object.keys(INTEGRATION_PACKAGES);
const forceAll = process.argv.includes('--all');

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
    console.log('Integrations to test:', integrations);
  }
}

// --all flag: test everything
if (forceAll) {
  writeResults(ALL_INTEGRATIONS);
  process.exit(0);
}

// Use changeset CLI to get the list of changed packages (same pattern as release-preview.ts)
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
  writeResults([]);
  process.exit(0);
}

let status: any;
try {
  status = JSON.parse(readFileSync(statusFilePath, 'utf-8'));
} finally {
  unlinkSync(statusFilePath);
}

// Collect all package names from changeset releases
const changedPackages = new Set<string>(
  status.releases
    ?.filter((r: { type: string }) => r.type !== 'none')
    .map((r: { name: string }) => r.name) ?? [],
);

// Changes to core varlock package trigger all integration tests
if (changedPackages.has('varlock')) {
  writeResults(ALL_INTEGRATIONS);
  process.exit(0);
}

// Otherwise, only test integrations whose packages changed
const integrationsList = Object.entries(INTEGRATION_PACKAGES)
  .filter(([, packages]) => packages.some((pkg) => changedPackages.has(pkg)))
  .map(([name]) => name);

if (!process.env.GITHUB_OUTPUT) {
  console.log('Changed packages:', [...changedPackages]);
}
writeResults(integrationsList);
