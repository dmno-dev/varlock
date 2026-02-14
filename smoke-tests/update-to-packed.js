#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Find packed .tgz files
const packedDir = join(import.meta.dirname, '../packed-packages');
const tgzFiles = readdirSync(packedDir).filter((f) => f.endsWith('.tgz'));

const varlockTgz = tgzFiles.find((f) => f.startsWith('varlock-') && !f.includes('astro') && !f.includes('nextjs'));
const astroTgz = tgzFiles.find((f) => f.includes('astro-integration'));
const nextjsTgz = tgzFiles.find((f) => f.includes('nextjs-integration'));

if (!varlockTgz || !astroTgz || !nextjsTgz) {
  console.error('Missing packed packages:', { varlockTgz, astroTgz, nextjsTgz });
  process.exit(1);
}

// Update root smoke-tests package.json
const rootPkgPath = join(import.meta.dirname, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
rootPkg.devDependencies.varlock = `file:../packed-packages/${varlockTgz}`;
rootPkg.pnpm.overrides['@next/env'] = `file:../packed-packages/${nextjsTgz}`;
writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);

// Update Astro package.json
const astroPkgPath = join(import.meta.dirname, 'smoke-test-astro/package.json');
const astroPkg = JSON.parse(readFileSync(astroPkgPath, 'utf-8'));
astroPkg.dependencies['@varlock/astro-integration'] = `file:../../packed-packages/${astroTgz}`;
astroPkg.dependencies.varlock = `file:../../packed-packages/${varlockTgz}`;
writeFileSync(astroPkgPath, `${JSON.stringify(astroPkg, null, 2)}\n`);

// Update Next.js package.json
const nextPkgPath = join(import.meta.dirname, 'smoke-test-nextjs/package.json');
const nextPkg = JSON.parse(readFileSync(nextPkgPath, 'utf-8'));
nextPkg.dependencies['@varlock/nextjs-integration'] = `file:../../packed-packages/${nextjsTgz}`;
nextPkg.dependencies.varlock = `file:../../packed-packages/${varlockTgz}`;
writeFileSync(nextPkgPath, `${JSON.stringify(nextPkg, null, 2)}\n`);

console.log('✅ Updated package.json files to use packed packages');
