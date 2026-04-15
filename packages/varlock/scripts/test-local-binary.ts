#!/usr/bin/env bun

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PKG_DIR = path.resolve(import.meta.dir, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..');

const DIST_SEA_DIR = path.join(PKG_DIR, 'dist-sea');
const SEA_BINARY_PATH = path.join(DIST_SEA_DIR, process.platform === 'win32' ? 'varlock.exe' : 'varlock');
const WIN_HELPER_PATH = path.join(PKG_DIR, 'native-bins', 'win32-x64', 'varlock-local-encrypt.exe');
const SEA_WIN_HELPER_PATH = path.join(DIST_SEA_DIR, 'varlock-local-encrypt.exe');

function run(cmd: string, opts?: { cwd?: string; stdio?: 'inherit' | 'pipe'; env?: NodeJS.ProcessEnv }): string {
  console.log(`\n> ${cmd}`);
  const output = execSync(cmd, {
    cwd: opts?.cwd ?? REPO_ROOT,
    stdio: opts?.stdio ?? 'pipe',
    env: opts?.env ?? process.env,
    encoding: 'utf-8',
  });

  if (opts?.stdio !== 'inherit' && output) {
    process.stdout.write(output);
  }

  return output ?? '';
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;

  try {
    const version = fs.readFileSync('/proc/version', 'utf-8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

function ensureWindowsHelperForWSL() {
  if (!isWSL()) return;

  if (!commandExists('cargo')) {
    console.warn('\n[local-binary-helper] WSL detected but cargo is not installed; skipping windows helper build.');
    console.warn('[local-binary-helper] Install Rust in WSL or build helper from Windows:');
    console.warn('  bun run --filter @varlock/encryption-binary-rust build:windows-x64');
    return;
  }

  run('bun run --filter @varlock/encryption-binary-rust build:windows-x64', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function copyWindowsHelperIfPresent() {
  if (!isWSL()) return;

  if (!fs.existsSync(WIN_HELPER_PATH)) {
    console.warn(`\n[local-binary-helper] Windows helper not found at ${WIN_HELPER_PATH}`);
    return;
  }

  fs.mkdirSync(DIST_SEA_DIR, { recursive: true });
  fs.copyFileSync(WIN_HELPER_PATH, SEA_WIN_HELPER_PATH);
  console.log(`[local-binary-helper] Copied helper to ${SEA_WIN_HELPER_PATH}`);
}

function runSmokeTests() {
  if (!fs.existsSync(SEA_BINARY_PATH)) {
    throw new Error(`SEA binary not found at ${SEA_BINARY_PATH}`);
  }

  run(`"${SEA_BINARY_PATH}" --version`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, VARLOCK_DEBUG: '1' },
  });

  run(`"${SEA_BINARY_PATH}" load`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, VARLOCK_DEBUG: '1' },
  });
}

function main() {
  ensureWindowsHelperForWSL();

  run('bun run --filter varlock build:binary', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  copyWindowsHelperIfPresent();
  runSmokeTests();

  console.log('\n[local-binary-helper] Completed local binary build + smoke test.');
}

main();
