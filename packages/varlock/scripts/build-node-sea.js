/*
  Builds a node binary with using Nodes SEA feature (experimental)
  https://nodejs.org/api/single-executable-applications.html
*/
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const DIST_DIR = 'dist-sea';
const BIN_PATH = 'dist-sea/varlock';

execSync('rm -rf dist-sea');
execSync('mkdir dist-sea');

console.log('Building single-file CJS version of CLI');
execSync('pnpm exec tsup --config tsup-sea.config.ts');

console.log('Creating sea-config.json');
fs.writeFileSync(`${DIST_DIR}/sea-config.json`, JSON.stringify({
  main: `${DIST_DIR}/cli-executable.cjs`,
  output: `${DIST_DIR}/sea-prep.blob`,
}));

console.log('Generating SEA blob');
execSync(`node --experimental-sea-config ${DIST_DIR}/sea-config.json`);

console.log('Copying node binary');
execSync(`cp "$(command -v node)" "${BIN_PATH}"`);

console.log('Removing codesignature of node binary');
execSync(`codesign --remove-signature "${BIN_PATH}"`);

console.log('Postjecting node binary with SEA blob');
execSync(
  `pnpm dlx postject ${BIN_PATH} NODE_SEA_BLOB ${DIST_DIR}/sea-prep.blob`
  + ' --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  + ' --macho-segment-name NODE_SEA',
);

// console.log('Signing node binary');
execSync(`codesign --sign - "${BIN_PATH}"`);

console.log('Done');
process.exit(0);
