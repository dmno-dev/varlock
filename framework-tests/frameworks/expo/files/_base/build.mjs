/**
 * Minimal build script that transforms source files through the real expo
 * babel plugin (which loads varlock config via the CLI). Output is written
 * to dist/ so the test harness can inspect files, and also printed to stdout
 * for output assertions.
 */
import { transformFileSync } from '@babel/core';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(import.meta.dirname, 'app');
const OUT_DIR = join(import.meta.dirname, 'dist');

mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(SRC_DIR).filter((f) => /\.[tj]sx?$/.test(f));

for (const file of files) {
  const srcPath = join(SRC_DIR, file);
  const result = transformFileSync(srcPath, {
    presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
    plugins: ['@varlock/expo-integration/babel-plugin'],
    filename: srcPath,
  });

  if (result?.code) {
    const outName = file.replace(/\.tsx?$/, '.js');
    writeFileSync(join(OUT_DIR, outName), result.code);
    console.log(`--- ${outName} ---`);
    console.log(result.code);
  }
}

console.log(`\nTransformed ${files.length} files`);
