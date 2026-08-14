#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Copies a platform's native binary from the monorepo staging directory
 * (packages/varlock/native-bins/<subdir>) into the platform package dir.
 *
 * Runs as the `prepack` script of each @varlock/native-helper-* package, so
 * packing/publishing always picks up the freshly staged (signed) binary and
 * an empty platform package can never be packed.
 */

import fs from 'node:fs';
import path from 'node:path';

const SUBDIR_CONTENTS: Record<string, string> = {
  darwin: 'VarlockEnclave.app',
  'linux-x64': 'varlock-local-encrypt',
  'linux-arm64': 'varlock-local-encrypt',
  'win32-x64': 'varlock-local-encrypt.exe',
};

const subdir = process.argv[2];
if (!subdir || !(subdir in SUBDIR_CONTENTS)) {
  console.error(`Usage: bun run prepack.ts <${Object.keys(SUBDIR_CONTENTS).join('|')}>`);
  process.exit(1);
}

const entry = SUBDIR_CONTENTS[subdir];
const srcPath = path.resolve(import.meta.dir, '..', 'varlock', 'native-bins', subdir, entry);
const destPath = path.resolve(import.meta.dir, subdir, entry);

if (!fs.existsSync(srcPath)) {
  console.error(`[native-helpers] missing native binary: ${srcPath}`);
  console.error('[native-helpers] build it (or restore it from CI artifacts) first - refusing to pack an empty platform package');
  process.exit(1);
}

fs.rmSync(destPath, { recursive: true, force: true });
fs.cpSync(srcPath, destPath, { recursive: true });

// artifact download / extraction can strip the execute bit
if (!subdir.startsWith('win32')) {
  const mainBinary = subdir === 'darwin'
    ? path.join(destPath, 'Contents', 'MacOS', 'varlock-local-encrypt')
    : destPath;
  fs.chmodSync(mainBinary, 0o755);
}

console.log(`[native-helpers] staged ${entry} for ${subdir}`);
