#!/usr/bin/env bun
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspaces } from './list-workspaces';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MONOREPO_ROOT = path.resolve(__dirname, '..');

type Workspace = { name: string; version: string; path: string };

function runGitCommand(cmd: string) {
  return execSync(cmd, {
    cwd: MONOREPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function safeRunGitCommand(cmd: string): string | null {
  try {
    return runGitCommand(cmd);
  } catch {
    return null;
  }
}

function fetchRefIfNeeded(ref: string) {
  if (!ref.startsWith('origin/')) return;
  const branch = ref.slice('origin/'.length);
  if (!branch) return;

  try {
    execSync(`git fetch origin ${branch} --depth=1`, {
      cwd: MONOREPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // If fetch fails, later diff will fail and we fall back safely.
  }
}

function parseAuditLevel(args: Array<string>) {
  const flag = args.find((arg) => arg.startsWith('--audit-level='));
  return flag?.split('=')[1] || 'moderate';
}

function resolveBaseRef() {
  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) return `origin/${baseRef}`;

  const beforeSha = process.env.GITHUB_EVENT_BEFORE;
  if (beforeSha && !/^0+$/.test(beforeSha)) return beforeSha;

  const mergeBase = safeRunGitCommand('git merge-base HEAD origin/main');
  if (mergeBase) return mergeBase;

  const previousCommit = safeRunGitCommand('git rev-parse HEAD~1');
  if (previousCommit) return previousCommit;

  return null;
}

function getChangedFiles(baseRef: string) {
  const diff = runGitCommand(`git diff --name-only ${baseRef}...HEAD`);
  return diff.split('\n').filter(Boolean);
}

function isWithinDir(filePath: string, directory: string) {
  return filePath === directory || filePath.startsWith(`${directory}/`);
}

function getChangedWorkspaces(changedFiles: Array<string>, workspaces: Array<Workspace>) {
  const changed = new Map<string, Workspace>();

  for (const filePath of changedFiles) {
    for (const ws of workspaces) {
      const relativeWsDir = path.relative(MONOREPO_ROOT, ws.path).replace(/\\/g, '/');
      if (isWithinDir(filePath, relativeWsDir)) {
        changed.set(ws.path, ws);
        break;
      }
    }
  }

  return [...changed.values()];
}

function shouldAuditRoot(changedFiles: Array<string>) {
  const rootTriggers = new Set([
    'package.json',
    '.npmrc',
  ]);
  return changedFiles.some((filePath) => rootTriggers.has(filePath));
}

function runAudit(cwd: string, label: string, auditLevel: string) {
  console.log(`\n--- bun audit (${label}) ---`);
  const result = spawnSync('bun', ['audit', `--audit-level=${auditLevel}`], {
    cwd,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main() {
  const auditLevel = parseAuditLevel(process.argv.slice(2));
  const baseRef = resolveBaseRef();

  if (!baseRef) {
    console.log('Could not determine a git base ref. Running full root audit as fallback.');
    runAudit(MONOREPO_ROOT, 'repo-root (fallback)', auditLevel);
    return;
  }

  fetchRefIfNeeded(baseRef);

  let changedFiles: Array<string>;
  try {
    changedFiles = getChangedFiles(baseRef);
  } catch (err) {
    console.log(`Failed to diff against ${baseRef}. Running full root audit as fallback.`);
    if (err instanceof Error && err.message) {
      console.log(err.message);
    }
    runAudit(MONOREPO_ROOT, 'repo-root (fallback)', auditLevel);
    return;
  }

  if (changedFiles.length === 0) {
    console.log(`No changed files since ${baseRef}. Skipping audit.`);
    return;
  }

  const workspaces = await listWorkspaces(MONOREPO_ROOT);
  const changedWorkspaces = getChangedWorkspaces(changedFiles, workspaces);
  const auditRoot = shouldAuditRoot(changedFiles);

  console.log(`Base ref: ${baseRef}`);
  console.log(`Changed files: ${changedFiles.length}`);
  console.log(`Changed workspaces: ${changedWorkspaces.map((ws) => ws.name).join(', ') || '(none)'}`);
  console.log(`Root audit required: ${auditRoot}`);

  if (auditRoot) {
    runAudit(MONOREPO_ROOT, 'repo-root', auditLevel);
  }

  if (changedWorkspaces.length === 0) {
    if (!auditRoot) {
      console.log('No changed workspace packages and no root dependency metadata changed. Skipping audit.');
    }
    return;
  }

  for (const ws of changedWorkspaces) {
    runAudit(ws.path, ws.name, auditLevel);
  }
}

await main();
