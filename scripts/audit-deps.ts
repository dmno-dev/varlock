#!/usr/bin/env bun
/**
 * Runs `bun audit` against the root lockfile (bun audits the whole lockfile regardless of cwd,
 * so per-workspace runs add nothing).
 *
 * Modes:
 * - `--mode=full` (default): fail on any advisory at or above the audit level
 * - `--mode=pr`: only fail if this branch changes bun.lock or .npmrc, committed or left uncommitted
 *   by a preceding `bun install` (any dep, catalog, or override change in a package.json shows up
 *   in bun.lock, while script-only edits don't). Otherwise
 *   advisories are reported as warnings, since they already exist on the base branch and are not
 *   this PR's to fix.
 */
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MONOREPO_ROOT = path.resolve(__dirname, '..');

// Advisories with no fix reachable from our dependency ranges. Each entry needs a reason;
// remove it once upstream ships a compatible fix.
const IGNORED_ADVISORIES: Record<string, string> = {
  // simple-git via @nuxt/devtools (dev-only). Fixed only in simple-git 4, which drops the
  // default export that @nuxt/devtools 3.x imports, so an override would break devtools.
  'GHSA-v5rq-49vh-5v5c': 'simple-git VISUAL editor detection',
  'GHSA-x6jw-m9v5-85vh': 'simple-git trailer command config',
};

function getArg(name: string, fallback: string) {
  const flag = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return flag?.split('=')[1] || fallback;
}

function safeGit(cmd: string): string | null {
  try {
    return execSync(cmd, { cwd: MONOREPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function resolveBaseRef() {
  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    safeGit(`git fetch origin ${baseRef} --depth=1`);
    return `origin/${baseRef}`;
  }
  return safeGit('git merge-base HEAD origin/main');
}

function isDepMetadataFile(filePath: string) {
  return filePath === 'bun.lock' || filePath === '.npmrc';
}

/** returns true when deps changed, or when we can't tell (fail safe = blocking) */
function depsChanged() {
  // CI runs a non-frozen `bun install` first, so a package.json dep change committed without its
  // lockfile update shows up as an uncommitted bun.lock change
  const uncommitted = safeGit('git status --porcelain -- bun.lock .npmrc');
  if (uncommitted === null || uncommitted) {
    console.log(uncommitted
      ? `Uncommitted dependency file changes (lockfile out of date with package.json):\n${uncommitted}`
      : 'Failed to check working tree, treating audit as blocking.');
    return true;
  }

  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.log('Could not determine a base ref, treating audit as blocking.');
    return true;
  }
  const diff = safeGit(`git diff --name-only ${baseRef}...HEAD`);
  if (diff === null) {
    console.log(`Failed to diff against ${baseRef}, treating audit as blocking.`);
    return true;
  }
  const changedDepFiles = diff.split('\n').filter(Boolean).filter(isDepMetadataFile);
  console.log(`Base ref: ${baseRef}`);
  console.log(`Changed dependency files: ${changedDepFiles.join(', ') || '(none)'}`);
  return changedDepFiles.length > 0;
}

const auditLevel = getArg('audit-level', 'moderate');
const mode = getArg('mode', 'full');
const blocking = mode === 'pr' ? depsChanged() : true;

const ignoreArgs = Object.keys(IGNORED_ADVISORIES).map((id) => `--ignore=${id}`);
const result = spawnSync('bun', ['audit', `--audit-level=${auditLevel}`, ...ignoreArgs], {
  cwd: MONOREPO_ROOT,
  stdio: 'inherit',
});

if (result.status !== 0) {
  if (blocking) process.exit(result.status ?? 1);
  // GitHub annotation so it's visible on the PR without failing the check
  console.log(`::warning title=Dependency audit::bun audit found ${auditLevel}+ advisories that already exist on the base branch. Not blocking since this PR does not change dependencies.`);
}
