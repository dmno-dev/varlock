import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..');
const DIST_DIR = 'dist-sea';
const NATIVE_BINS_DIR = path.join(PKG_DIR, 'native-bins');
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

    // Bundle platform-specific native binaries alongside the CLI binary
    const isMac = archiveName.startsWith('macos-');
    if (isMac) {
      const appBundleSrc = path.join(NATIVE_BINS_DIR, 'darwin', 'VarlockEnclave.app');
      if (fs.existsSync(appBundleSrc)) {
        console.log('  Bundling macOS native binary (VarlockEnclave.app)');
        exec(`cp -R "${appBundleSrc}" "${targetDir}/VarlockEnclave.app"`);
      } else {
        console.log(`  Warning: macOS native binary not found at ${appBundleSrc}, skipping`);
      }
    }

    // Bundle Rust native binary for Linux/Windows
    let nativeBinSubdir: string | null = null;
    if (isWin) {
      nativeBinSubdir = 'win32-x64';
    } else if (archiveName.startsWith('linux-musl-')) {
      nativeBinSubdir = `linux-${archiveName.replace('linux-musl-', '')}`;
    } else if (archiveName.startsWith('linux-')) {
      nativeBinSubdir = `linux-${archiveName.replace('linux-', '')}`;
    }

    if (nativeBinSubdir && !isMac) {
      const rustBinaryName = isWin ? 'varlock-local-encrypt.exe' : 'varlock-local-encrypt';
      const rustBinarySrc = path.join(NATIVE_BINS_DIR, nativeBinSubdir, rustBinaryName);
      if (fs.existsSync(rustBinarySrc)) {
        console.log(`  Bundling Rust native binary (${nativeBinSubdir}/${rustBinaryName})`);
        exec(`cp "${rustBinarySrc}" "${targetDir}/${rustBinaryName}"`);
      } else {
        console.log(`  Warning: Rust native binary not found at ${rustBinarySrc}, skipping`);
      }
    }

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
