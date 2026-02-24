import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..');
const DIST_DIR = 'dist-sea';
const ENTRY = 'src/cli/cli-executable.ts';

const VERSION = process.env.RELEASE_VERSION;
if (!VERSION) throw new Error('RELEASE_VERSION env var must be set');

const TARGETS = [
  { bunTarget: 'bun-darwin-x64', archiveName: 'macos-x64' },
  { bunTarget: 'bun-darwin-arm64', archiveName: 'macos-arm64' },
  { bunTarget: 'bun-linux-x64', archiveName: 'linux-x64' },
  { bunTarget: 'bun-linux-arm64', archiveName: 'linux-arm64' },
  { bunTarget: 'bun-linux-x64-musl', archiveName: 'linux-musl-x64' },
  { bunTarget: 'bun-linux-arm64-musl', archiveName: 'linux-musl-arm64' },
  { bunTarget: 'bun-windows-x64', archiveName: 'win-x64' },
];

function exec(cmd) {
  execSync(cmd, { cwd: PKG_DIR, stdio: 'inherit' });
}

exec(`rm -rf ${DIST_DIR}`);
exec(`mkdir -p ${DIST_DIR}`);

for (const { bunTarget, archiveName } of TARGETS) {
  console.log(`Building: ${bunTarget}`);
  const isWin = archiveName.startsWith('win-');
  const targetDir = `${DIST_DIR}/${archiveName}`;
  const binName = `varlock${isWin ? '.exe' : ''}`;

  exec(`mkdir -p ${targetDir}`);
  exec(
    `bun build --compile --minify --sourcemap`
    + ` --target=${bunTarget}`
    + ` --define __VARLOCK_SEA_BUILD__=true`
    + ` --define __VARLOCK_BUILD_TYPE__='"release"'`
    + ` ${ENTRY}`
    + ` --outfile ${targetDir}/${binName}`
  );

  // Archive
  let archive, archiveCmd;
  if (isWin) {
    archive = `varlock-${archiveName}.zip`;
    archiveCmd = `zip -j ${DIST_DIR}/${archive} ${targetDir}/${binName}`;
  } else {
    archive = `varlock-${archiveName}.tar.gz`;
    archiveCmd = `tar --gzip -cf ${DIST_DIR}/${archive} -C ${targetDir}/ .`;
  }
  exec(archiveCmd);
  execSync(`sha256sum ${archive} >> checksums.txt`, {
    cwd: path.join(PKG_DIR, DIST_DIR),
  });
}
