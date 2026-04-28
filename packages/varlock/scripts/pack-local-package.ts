#!/usr/bin/env bun

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PKG_DIR = path.resolve(import.meta.dir, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..');
const WIN_HELPER_PATH = path.join(PKG_DIR, 'native-bins', 'win32-x64', 'varlock-local-encrypt.exe');

function run(cmd: string, opts?: { cwd?: string; stdio?: 'inherit' | 'pipe' }): string {
  console.log(`\n> ${cmd}`);
  const out = execSync(cmd, {
    cwd: opts?.cwd ?? REPO_ROOT,
    stdio: opts?.stdio ?? 'pipe',
    encoding: 'utf-8',
  });
  if (opts?.stdio !== 'inherit' && out) {
    process.stdout.write(out);
  }
  return out ?? '';
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

function maybeBuildWslHelper() {
  if (!isWSL()) return;

  if (!commandExists('cargo')) {
    console.warn('\n[pack-local] WSL detected but cargo is missing; skipping Windows helper build.');
    console.warn('[pack-local] Build helper from Windows (or install Rust in WSL) if needed:');
    console.warn('  bun run --filter @varlock/encryption-binary-rust build:windows-x64');
    return;
  }

  run('bun run --filter @varlock/encryption-binary-rust build:windows-x64', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function packVarlock(): string {
  run('bun run --filter varlock build', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  // Remove old tgz files so we can identify the new output deterministically.
  const oldTgzs = fs.readdirSync(PKG_DIR).filter((f) => f.endsWith('.tgz'));
  for (const file of oldTgzs) {
    fs.rmSync(path.join(PKG_DIR, file));
  }

  const output = run('npm pack', { cwd: PKG_DIR, stdio: 'pipe' }).trim();
  const tgzName = output.split('\n').at(-1)?.trim();
  if (!tgzName || !tgzName.endsWith('.tgz')) {
    throw new Error(`Unable to determine npm pack output from: ${output}`);
  }

  return path.resolve(PKG_DIR, tgzName);
}

function printUsageHelp(tgzPath: string) {
  const fileRef = `file:${tgzPath}`;

  console.log('\n[pack-local] Local package tarball ready:');
  console.log(`  ${tgzPath}`);

  console.log('\n[pack-local] Add this dependency value in your consuming app:');
  console.log(`  "varlock": "${fileRef}"`);

  if (isWSL() && !fs.existsSync(WIN_HELPER_PATH)) {
    console.log('\n[pack-local] Note: tarball currently has no WSL Windows helper binary at:');
    console.log(`  ${WIN_HELPER_PATH}`);
  }
}

function main() {
  maybeBuildWslHelper();
  const tgzPath = packVarlock();
  printUsageHelp(tgzPath);
}

main();
