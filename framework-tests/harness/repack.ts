/**
 * Re-packs all known varlock packages into .packed/ tarballs.
 * Run this after making changes to varlock source to pick them up in tests.
 */
import { packPackages } from './pack.js';

const PACKAGE_NAMES = [
  'varlock',
  '@varlock/nextjs-integration',
  '@varlock/astro-integration',
  '@varlock/vite-integration',
  '@varlock/cloudflare-integration',
  '@varlock/expo-integration',
];

// REPACK is set by the npm script, but ensure it's set if run directly
process.env.REPACK = '1';

console.log('Re-packing varlock packages...\n');
const result = packPackages(PACKAGE_NAMES);

console.log('\nPacked:');
for (const [name, path] of Object.entries(result)) {
  console.log(`  ${name} → ${path}`);
}
