/*
  Builds an bundled executable using pkg (maintained fork)
  https://github.com/yao-pkg/pkg
*/
import { execSync } from 'node:child_process';

const DIST_DIR = 'dist-sea';
const INPUT_PATH = 'dist-sea/cli-executable.cjs';
const BIN_PATH = 'dist-sea/varlock-pkg';

execSync(`rm -rf ${DIST_DIR}`);
execSync(`mkdir ${DIST_DIR}`);

console.log('Building single-file CJS version of CLI');
execSync('pnpm exec tsup --config tsup-sea.config.ts');

console.log('create sea using pkg');
execSync(`pnpm exec pkg ${INPUT_PATH} -o ${BIN_PATH}`);

// console.log('Signing node binary');
// execSync(`codesign --sign - "${BIN_PATH}"`);


console.log('Done');
process.exit(0);
