#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Removes the binary that prepack.ts copied in, once the tarball is built.
 * Leftover copies in these workspace dirs would otherwise shadow fresher
 * build output during dev binary resolution (see binary-resolver.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { SUBDIR_CONTENTS } from './platforms';

const subdir = process.argv[2];
if (!subdir || !(subdir in SUBDIR_CONTENTS)) {
  console.error(`Usage: bun run postpack.ts <${Object.keys(SUBDIR_CONTENTS).join('|')}>`);
  process.exit(1);
}

const destPath = path.resolve(import.meta.dir, subdir, SUBDIR_CONTENTS[subdir]);
fs.rmSync(destPath, { recursive: true, force: true });
console.log(`[native-helpers] cleaned up staged binary for ${subdir}`);
