import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VARLOCK_DIR = 'packages/varlock';
const DIST_DIR = './dist-sea';

// make sure the compiled executable is already in the dist-sea directory
const executableCjsFile = `${DIST_DIR}/cli-executable.cjs`;
if (!fs.existsSync(`${VARLOCK_DIR}/${executableCjsFile}`)) {
  throw new Error(`${VARLOCK_DIR}/${executableCjsFile} not found`);
}

const VERSION = process.env.RELEASE_VERSION;
if (!VERSION) {
  throw new Error('RELEASE_VERSION env var must be set');
}

// see https://github.com/yao-pkg/pkg
const NODE_RANGE = 'node22';
// platform -- alpine, linux, linuxstatic, win, macos, (freebsd)
// arch -- x64, arm64, (armv6, armv7)
const TARGETS = [
  'macos-x64',
  'macos-arm64',
  'linuxstatic-x64',
  'linuxstatic-arm64',
  'linuxstatic-armv7',
  'win-x64',
  'win-arm64',
];

// reusable exec fn with some pre-set options
function exec(cmd) {
  execSync(cmd, {
    cwd: VARLOCK_DIR,
    stdio: 'inherit',
  });
}

// might need to do this when running on GH actions?
// sudo chown -R root:root ./dist-sea/

for (const pkgTarget of TARGETS) {
  console.log(`Pkg-ing target: ${pkgTarget}`);
  const targetOutputName = pkgTarget.replace('linuxstatic', 'linux');
  const targetPkgDir = `${DIST_DIR}/${targetOutputName}`;
  const targetBinName = `varlock${targetOutputName.startsWith('win-') ? '.exe' : ''}`;

  // run pkg to build binary
  exec(`./node_modules/.bin/pkg ${executableCjsFile} --public-packages "*" --public --target ${NODE_RANGE}-${pkgTarget} --output ${targetPkgDir}/${targetBinName}`);

  // create .tar.gz file
  let archiveName = `varlock-${targetOutputName}.tar.gz`;
  let archiveCmd = `tar --gzip -cf ${DIST_DIR}/${archiveName} -C ${targetPkgDir}/ .`;
  // create .zip for windows only
  if (targetOutputName.startsWith('win-')) {
    archiveName = `varlock-${targetOutputName}.zip`;
    archiveCmd = `zip -j ${DIST_DIR}/${archiveName} ${targetPkgDir}/${targetBinName}`;
  }

  exec(archiveCmd);
  // we set the cwd so that the checksums.txt has the filename only without any directory
  execSync(`sha256sum ${archiveName} >> checksums.txt`, {
    cwd: path.join(VARLOCK_DIR, DIST_DIR),
  });
}

