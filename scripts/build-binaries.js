import { execSync } from 'node:child_process';
import fs from 'node:fs';

const VARLOCK_DIR = 'packages/varlock';
const DIST_DIR = './dist-sea';

// make sure the compiled executable is already in the dist-sea directory
const executableCjsFile = `${DIST_DIR}/cli-executable.cjs`;
if (!fs.existsSync(`${VARLOCK_DIR}/${executableCjsFile}`)) {
  throw new Error(`${VARLOCK_DIR}/${executableCjsFile} not found`);
}

const VERSION = process.env.RELEASE_VERSION;

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
  const outputName = pkgTarget.replace('linuxstatic', 'linux');
  const targetPkgDir = `${DIST_DIR}/${outputName}`;
  const targetBinName = `varlock${outputName.startsWith('windows') ? '.exe' : ''}`;

  // run pkg to build binary
  exec(`./node_modules/.bin/pkg ${executableCjsFile} --public-packages "*" --public --target ${NODE_RANGE}-${pkgTarget} --output ${targetPkgDir}/${targetBinName}`);

  // create .tar.gz file
  const archiveName = `varlock-${VERSION}-${outputName}.tar.gz`;
  exec(`tar --gzip -cf ${DIST_DIR}/${archiveName} -C ${targetPkgDir}/ .`);

  // create .zip for windows only
  if (outputName.startsWith('windows')) {
    const zipName = `varlock-${VERSION}-${outputName}.zip`;
    exec(`zip -j ${DIST_DIR}/${zipName} ${targetPkgDir}/${targetBinName}`);
  }
}

