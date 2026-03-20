import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..');
const DIST_DIR = 'dist-sea';
const ENTRY = 'src/cli/cli-executable.ts';

const ALL_TARGETS = [
  { bunTarget: 'bun-darwin-x64', archiveName: 'macos-x64' },
  { bunTarget: 'bun-darwin-arm64', archiveName: 'macos-arm64' },
  { bunTarget: 'bun-linux-x64', archiveName: 'linux-x64' },
  { bunTarget: 'bun-linux-arm64', archiveName: 'linux-arm64' },
  { bunTarget: 'bun-linux-x64-musl', archiveName: 'linux-musl-x64' },
  { bunTarget: 'bun-linux-arm64-musl', archiveName: 'linux-musl-arm64' },
  { bunTarget: 'bun-windows-x64', archiveName: 'win-x64' },
];

const devMode = process.argv.includes('--dev');

function exec(cmd: string) {
  execSync(cmd, { cwd: PKG_DIR, stdio: 'inherit' });
}

exec(`rm -rf ${DIST_DIR}`);
exec(`mkdir -p ${DIST_DIR}`);

// dev mode = only build for the current platform, into dist-sea/varlock
if (devMode) {
  const binName = process.platform === 'win32' ? 'varlock.exe' : 'varlock';
  exec([
    'bun build',
    '--compile',
    '--minify',
    '--sourcemap',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--define __VARLOCK_SEA_BUILD__=true',
    '--define __VARLOCK_BUILD_TYPE__=\'"dev"\'',
    `--outfile ${DIST_DIR}/${binName}`,
    ENTRY,
  ].join(' '));
} else {
  // Build for all platforms and create archives
  for (const { bunTarget, archiveName } of ALL_TARGETS) {
    console.log(`Building: ${bunTarget}`);
    const isWin = archiveName.startsWith('win-');
    const targetDir = `${DIST_DIR}/${archiveName}`;
    const binName = `varlock${isWin ? '.exe' : ''}`;

    exec(`mkdir -p ${targetDir}`);
    exec([
      'bun build',
      '--compile',
      // --bytecode segfaults on cross-compiled Windows binaries
      // TODO: remove when bun fixes this
      ...(isWin ? [] : ['--bytecode']),
      '--minify',
      '--sourcemap',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      `--target=${bunTarget}`,
      '--define __VARLOCK_SEA_BUILD__=true',
      '--define __VARLOCK_BUILD_TYPE__=\'"release"\'',
      `--outfile ${targetDir}/${binName}`,
      ENTRY,
    ].join(' '));

    // Archive
    let archive: string;
    let archiveCmd: string;
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
}
