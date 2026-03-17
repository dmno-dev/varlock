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
const INTEGRATION_PACKAGES: Record<string, Array<string>> = {
  nextjs: ['@varlock/nextjs-integration'],
  // astro: ['@varlock/astro-integration'],
  // vite: ['@varlock/vite-integration'],
};

function writeGithubOutputs(outputs: Record<string, string>) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

const REPO_ROOT = join(import.meta.dirname, '..');
const STATUS_FILE = 'changesets-summary.json';
const statusFilePath = join(REPO_ROOT, STATUS_FILE);

function writeNoChanges() {
  console.log('No changesets found');
  writeGithubOutputs({
    'any-changed': 'false',
    integrations: '[]',
    ...Object.fromEntries(Object.keys(INTEGRATION_PACKAGES).map((name) => [name, 'false'])),
  });
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
  writeNoChanges();
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

// Build output: which integrations have framework tests that should run
const result: Record<string, boolean> = {};
for (const [integration, packages] of Object.entries(INTEGRATION_PACKAGES)) {
  result[integration] = packages.some((pkg) => changedPackages.has(pkg));
}

const anyChanged = Object.values(result).some(Boolean);
const integrationsList = Object.entries(result)
  .filter(([, changed]) => changed)
  .map(([name]) => name);

writeGithubOutputs({
  'any-changed': String(anyChanged),
  integrations: JSON.stringify(integrationsList),
  ...Object.fromEntries(Object.entries(result).map(([name, changed]) => [name, String(changed)])),
});

if (!process.env.GITHUB_OUTPUT) {
  console.log('Changed packages:', [...changedPackages]);
  console.log('Integration results:', result);
  console.log('Integrations to test:', integrationsList);
}
