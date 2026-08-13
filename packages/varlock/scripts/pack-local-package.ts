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

// npm-name suffix -> native-bins staging entry, for the per-platform binary packages
const PLATFORM_PACKAGES: Record<string, string> = {
  darwin: 'VarlockEnclave.app',
  'linux-x64': 'varlock-local-encrypt',
  'linux-arm64': 'varlock-local-encrypt',
  'win32-x64': 'varlock-local-encrypt.exe',
};

// bun pm pack resolves workspace:*/catalog: protocols (npm pack does not) and
// runs prepack. Detect the produced tarball from the directory listing since
// bun's pack output is not machine-parseable.
function packPackage(dir: string): string {
  const oldTgzs = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  for (const file of oldTgzs) {
    fs.rmSync(path.join(dir, file));
  }

  run('bun pm pack', { cwd: dir, stdio: 'pipe' });

  const tgzName = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tgzName) {
    throw new Error(`bun pm pack produced no tarball in ${dir}`);
  }
  return path.resolve(dir, tgzName);
}

function packVarlock(): string {
  run('bun run --filter varlock build', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  return packPackage(PKG_DIR);
}

// Pack the per-platform binary packages whose binary is staged locally in
// packages/varlock/native-bins (populated by the swift/rust build scripts).
// Their prepack script copies the binary in and fails if it is missing.
function packPlatformPackages(): Record<string, string> {
  const packed: Record<string, string> = {};
  for (const [suffix, entry] of Object.entries(PLATFORM_PACKAGES)) {
    const stagedPath = path.join(PKG_DIR, 'native-bins', suffix, entry);
    if (!fs.existsSync(stagedPath)) continue;
    const pkgDir = path.join(REPO_ROOT, 'packages', 'native-helpers', suffix);
    packed[`@varlock/native-helper-${suffix}`] = packPackage(pkgDir);
  }
  return packed;
}

function printUsageHelp(tgzPath: string, platformTgzs: Record<string, string>) {
  const fileRef = `file:${tgzPath}`;

  console.log('\n[pack-local] Local package tarball ready:');
  console.log(`  ${tgzPath}`);

  console.log('\n[pack-local] Add this dependency value in your consuming app:');
  console.log(`  "varlock": "${fileRef}"`);

  const platformEntries = Object.entries(platformTgzs);
  if (platformEntries.length) {
    console.log('\n[pack-local] Platform binary tarballs (native local-encryption helpers):');
    console.log('[pack-local] To use one, add an override in your consuming app');
    console.log('[pack-local] ("overrides" for npm/bun, "pnpm.overrides" for pnpm, "resolutions" for yarn):');
    console.log('  "overrides": {');
    console.log(platformEntries.map(([name, p]) => `    "${name}": "file:${p}"`).join(',\n'));
    console.log('  }');
  } else {
    console.log('\n[pack-local] Note: no native binaries staged in native-bins/, so no platform');
    console.log('[pack-local] packages were packed. Local encryption will use the file-based');
    console.log('[pack-local] fallback (or build a native binary first, then re-run).');
  }

  if (isWSL() && !fs.existsSync(WIN_HELPER_PATH)) {
    console.log('\n[pack-local] Note: no WSL Windows helper binary staged at:');
    console.log(`  ${WIN_HELPER_PATH}`);
  }
}

function main() {
  maybeBuildWslHelper();
  const tgzPath = packVarlock();
  const platformTgzs = packPlatformPackages();
  printUsageHelp(tgzPath, platformTgzs);
}

main();
