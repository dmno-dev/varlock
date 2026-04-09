#!/usr/bin/env bun

/**
 * Build script for the varlock-local-encrypt Rust binary.
 *
 * Usage:
 *   bun run scripts/build-rust.ts                         # build for current platform
 *   bun run scripts/build-rust.ts --target x86_64-unknown-linux-musl
 *   bun run scripts/build-rust.ts --target x86_64-pc-windows-msvc
 *
 * The binary is placed in packages/varlock/native-bins/<platform>[-<arch>]/
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// ── CLI args ────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const target = getArg('--target');

// ── Paths ───────────────────────────────────────────────────────

const rustDir = path.resolve(import.meta.dir, '..');
const varlockPkgDir = path.resolve(import.meta.dir, '..', '..', 'varlock');
const binaryName = process.platform === 'win32' && !target?.includes('linux')
  ? 'varlock-local-encrypt.exe'
  : 'varlock-local-encrypt';

/**
 * Map a Rust target triple to the native-bins subdirectory name.
 */
function getOutputSubdir(rustTarget?: string): string {
  if (!rustTarget) {
    // Current platform
    if (process.platform === 'darwin') return 'darwin';
    if (process.platform === 'win32') return `win32-${process.arch}`;
    return `${process.platform}-${process.arch}`;
  }

  // Parse Rust target triple: <arch>-<vendor>-<os>[-<env>]
  const parts = rustTarget.split('-');
  const arch = parts[0];
  const os = parts[2];

  let nodeArch = arch;
  if (arch === 'x86_64') nodeArch = 'x64';
  else if (arch === 'aarch64') nodeArch = 'arm64';

  if (os === 'linux') return `linux-${nodeArch}`;
  if (os === 'windows') return `win32-${nodeArch}`;
  if (os === 'darwin' || os === 'apple') return 'darwin';
  return `${os}-${nodeArch}`;
}

function run(cmd: string, opts?: { cwd?: string }) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: opts?.cwd ?? rustDir });
}

// ── Build ───────────────────────────────────────────────────────

const buildArgs = ['cargo', 'build', '--release'];
if (target) {
  buildArgs.push('--target', target);
}

run(buildArgs.join(' '));

// ── Copy to native-bins ─────────────────────────────────────────

const subdir = getOutputSubdir(target);
const outputDir = path.join(varlockPkgDir, 'native-bins', subdir);
fs.mkdirSync(outputDir, { recursive: true });

// Find the built binary
let sourceBinary: string;
if (target) {
  const targetBinaryName = target.includes('windows')
    ? 'varlock-local-encrypt.exe'
    : 'varlock-local-encrypt';
  sourceBinary = path.join(rustDir, 'target', target, 'release', targetBinaryName);
} else {
  sourceBinary = path.join(rustDir, 'target', 'release', binaryName);
}

if (!fs.existsSync(sourceBinary)) {
  console.error(`Build succeeded but binary not found at: ${sourceBinary}`);
  process.exit(1);
}

const destBinary = path.join(outputDir, binaryName);
fs.copyFileSync(sourceBinary, destBinary);

// Ensure executable
if (process.platform !== 'win32') {
  fs.chmodSync(destBinary, 0o755);
}

const rawStats = fs.statSync(destBinary);
const rawSizeKB = Math.round(rawStats.size / 1024);

// UPX compress on Linux/Windows (macOS is not reliably supported)
const skipUpx = args.includes('--no-upx');
const isMacOS = !target ? process.platform === 'darwin' : (target.includes('darwin') || target.includes('apple'));
if (!skipUpx && !isMacOS) {
  try {
    console.log('\nCompressing with UPX...');
    execSync(`upx --best "${destBinary}"`, { stdio: 'inherit' });
  } catch {
    console.warn('UPX compression failed (is upx installed?), continuing with uncompressed binary');
  }
}

const stats = fs.statSync(destBinary);
const sizeKB = Math.round(stats.size / 1024);

console.log(`\nBuilt: ${destBinary}`);
const sizeStr = rawSizeKB !== sizeKB ? `${sizeKB} KB (${rawSizeKB} KB before UPX)` : `${sizeKB} KB`;
console.log(`Size: ${sizeStr}`);
console.log(`Platform: ${subdir}`);
console.log('Done!');
