/**
 * Transforms a React Native CLI-style screen through the real babel plugin.
 * Uses src/screens/Home.tsx (not Expo Router paths) to confirm sensitive-var
 * warnings fire for generic client-side RN code.
 */
import { transformFileSync } from '@babel/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const srcPath = join(import.meta.dirname, 'src/screens/Home.tsx');
const OUT_DIR = join(import.meta.dirname, 'dist');

mkdirSync(OUT_DIR, { recursive: true });

const result = transformFileSync(srcPath, {
  presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
  plugins: ['@varlock/expo-integration/babel-plugin'],
  filename: srcPath,
});

if (result?.code) {
  writeFileSync(join(OUT_DIR, 'Home.js'), result.code);
  console.log('--- Home.js ---');
  console.log(result.code);
}

console.log('\nTransformed 1 file');
