import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..');
const DIST_DIR = 'dist-sea';
const NATIVE_BINS_DIR = path.join(PKG_DIR, 'native-bins');
const ENTRY = 'src/cli/cli-executable.ts';
// Stable code-signing identifier for the macOS CLI binary. The enclave daemon can
// pin a designated requirement on this (plus our team ID), so treat it as
// permanent: changing it makes every existing release look like a different app.
const MAC_CODESIGN_IDENTIFIER = 'dev.varlock.cli';
// Grants only allow-jit. Without it hardened runtime disables JavaScriptCore's
// JIT and CPU-bound JS runs ~10x slower. It does not re-enable debugger attach.
// (codesign rejects XML comments in the plist, so the rationale lives here.)
const MAC_ENTITLEMENTS = path.join(PKG_DIR, 'varlock-cli.entitlements');

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
const skipNative = process.argv.includes('--skip-native');

function getArgValue(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return undefined;
  const arg = process.argv[idx];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  return process.argv[idx + 1];
}

// --targets=macos-x64,macos-arm64 builds a subset (archive names from ALL_TARGETS)
const targetsArg = getArgValue('--targets');
const selectedTargets = targetsArg
  ? targetsArg.split(',').map((t) => t.trim()).filter(Boolean)
  : undefined;
if (selectedTargets) {
  const unknown = selectedTargets.filter((t) => !ALL_TARGETS.some((x) => x.archiveName === t));
  if (unknown.length) throw new Error(`Unknown --targets: ${unknown.join(', ')}`);
}
const targets = selectedTargets
  ? ALL_TARGETS.filter((t) => selectedTargets.includes(t.archiveName))
  : ALL_TARGETS;

// macOS binaries are signed with hardened runtime, which blocks other same-user
// processes from attaching to varlock and reading resolved secrets out of memory.
// --sign <identity> uses a real (Developer ID) identity; otherwise we sign ad-hoc,
// which still applies hardened runtime. --no-sign skips signing (needed to attach
// a debugger to a local build). codesign only exists on macOS, so darwin targets
// cross-compiled elsewhere keep bun's linker-applied ad-hoc signature.
const signIdentity = getArgValue('--sign') ?? '-';
const noSign = process.argv.includes('--no-sign');

function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;

  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf-8'));
  } catch {
    return false;
  }
}

function exec(cmd: string) {
  execSync(cmd, { cwd: PKG_DIR, stdio: 'inherit' });
}

function signMacBinary(binPath: string) {
  if (noSign) {
    console.log(`  Skipping codesign for ${binPath} (--no-sign)`);
    return;
  }
  if (process.platform !== 'darwin') {
    console.log(`  Skipping codesign for ${binPath} (codesign requires macOS)`);
    return;
  }
  const isAdHoc = signIdentity === '-';
  console.log(`  Signing ${binPath} (${isAdHoc ? 'ad-hoc' : signIdentity}, hardened runtime)`);
  // Only the varlock Mach-O is signed, never --deep: re-signing the bundled
  // VarlockEnclave.app would invalidate its own signature and stapled ticket
  execFileSync('codesign', [
    '--force',
    '--sign',
    signIdentity,
    '--identifier',
    MAC_CODESIGN_IDENTIFIER,
    '--options',
    'runtime',
    '--entitlements',
    MAC_ENTITLEMENTS,
    // a secure timestamp is required for notarization, and not possible ad-hoc
    isAdHoc ? '--timestamp=none' : '--timestamp',
    binPath,
  ], { cwd: PKG_DIR, stdio: 'inherit' });
}

function sha256File(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

  // Bundle platform-specific native binary alongside the dev binary
  if (process.platform === 'darwin') {
    // sign dev builds too, so entitlement regressions show up before a release
    signMacBinary(`${DIST_DIR}/${binName}`);

    const appBundleSrc = path.join(NATIVE_BINS_DIR, 'darwin', 'VarlockEnclave.app');
    if (fs.existsSync(appBundleSrc)) {
      console.log('Bundling macOS native binary (VarlockEnclave.app)');
      exec(`cp -R "${appBundleSrc}" "${DIST_DIR}/VarlockEnclave.app"`);
    } else {
      console.log(`Warning: macOS native binary not found at ${appBundleSrc}, skipping`);
    }
  } else {
    const isWin = process.platform === 'win32';
    const useWindowsHelper = isWin || isWSL();
    const nativeBinSubdir = useWindowsHelper ? 'win32-x64' : `${process.platform}-${process.arch}`;
    const rustBinaryName = useWindowsHelper ? 'varlock-local-encrypt.exe' : 'varlock-local-encrypt';
    const rustBinarySrc = path.join(NATIVE_BINS_DIR, nativeBinSubdir, rustBinaryName);
    if (fs.existsSync(rustBinarySrc)) {
      console.log(`Bundling Rust native binary (${nativeBinSubdir}/${rustBinaryName})`);
      exec(`cp "${rustBinarySrc}" "${DIST_DIR}/${rustBinaryName}"`);
    } else {
      console.log(`Warning: Rust native binary not found at ${rustBinarySrc}, skipping`);
    }
  }
} else {
  // Build for all platforms and create archives
  for (const { bunTarget, archiveName } of targets) {
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

    const isMac = archiveName.startsWith('macos-');
    if (isMac) signMacBinary(`${targetDir}/${binName}`);

    // Bundle platform-specific native binaries alongside the CLI binary
    if (!skipNative) {
      if (isMac) {
        const appBundleSrc = path.join(NATIVE_BINS_DIR, 'darwin', 'VarlockEnclave.app');
        if (!fs.existsSync(appBundleSrc)) {
          throw new Error(`macOS native binary not found at ${appBundleSrc} — cannot build release without it`);
        }
        console.log('  Bundling macOS native binary (VarlockEnclave.app)');
        exec(`cp -R "${appBundleSrc}" "${targetDir}/VarlockEnclave.app"`);
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
        if (!fs.existsSync(rustBinarySrc)) {
          throw new Error(`Rust native binary not found at ${rustBinarySrc} — cannot build release without it`);
        }
        console.log(`  Bundling Rust native binary (${nativeBinSubdir}/${rustBinaryName})`);
        exec(`cp "${rustBinarySrc}" "${targetDir}/${rustBinaryName}"`);

        // Linux builds also bundle the Windows .exe for WSL2 support
        if (archiveName.startsWith('linux')) {
          const winExeSrc = path.join(NATIVE_BINS_DIR, 'win32-x64', 'varlock-local-encrypt.exe');
          if (!fs.existsSync(winExeSrc)) {
            throw new Error(`Windows native binary not found at ${winExeSrc} — needed for WSL2 support in Linux builds`);
          }
          console.log('  Bundling Windows .exe for WSL2 support');
          exec(`cp "${winExeSrc}" "${targetDir}/varlock-local-encrypt.exe"`);
        }
      }
    }

    // Archive
    let archive: string;
    let archiveCmd: string;
    if (isWin) {
      archive = `varlock-${archiveName}.zip`;
      archiveCmd = `zip -j ${DIST_DIR}/${archive} ${targetDir}/*`;
    } else {
      archive = `varlock-${archiveName}.tar.gz`;
      // COPYFILE_DISABLE keeps bsdtar on macOS from adding AppleDouble (._*) files
      archiveCmd = `COPYFILE_DISABLE=1 tar --gzip -cf ${DIST_DIR}/${archive} -C ${targetDir}/ .`;
    }
    exec(archiveCmd);
    // same format as `sha256sum` (two spaces), which other tooling parses
    fs.appendFileSync(
      path.join(PKG_DIR, DIST_DIR, 'checksums.txt'),
      `${sha256File(path.join(PKG_DIR, DIST_DIR, archive))}  ${archive}\n`,
    );
  }

  // Print size summary for all archives
  console.log('\n=== Release archive size summary ===');
  let totalBytes = 0;
  for (const { archiveName } of targets) {
    const isWin = archiveName.startsWith('win-');
    const ext = isWin ? 'zip' : 'tar.gz';
    const archivePath = path.join(PKG_DIR, DIST_DIR, `varlock-${archiveName}.${ext}`);
    if (fs.existsSync(archivePath)) {
      const size = fs.statSync(archivePath).size;
      totalBytes += size;
      const sizeMB = (size / 1024 / 1024).toFixed(1);
      console.log(`  varlock-${archiveName}.${ext}: ${sizeMB} MB`);
    }
  }
  const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
  console.log(`\n  Total: ${totalMB} MB`);
}
