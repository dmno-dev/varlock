import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..');
const DIST_DIR = 'dist-sea';
const NATIVE_BINS_DIR = path.join(PKG_DIR, 'native-bins');
const ENTRY = 'src/cli/cli-executable.ts';
const ENTITLEMENTS = path.join(PKG_DIR, 'varlock-cli.entitlements');

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

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

// --targets=macos-x64,macos-arm64 restricts the build to a subset of archives.
// Release CI uses it to split the macOS archives onto a macOS runner (where
// codesign exists) while the rest keep building on linux.
const targetsArg = process.argv.find((a) => a.startsWith('--targets='))?.slice('--targets='.length);
const selectedTargets = targetsArg
  ? targetsArg.split(',').map((t) => t.trim()).filter(Boolean)
  : null;
if (selectedTargets) {
  const known = new Set(ALL_TARGETS.map((t) => t.archiveName));
  const unknown = selectedTargets.filter((t) => !known.has(t));
  if (unknown.length) {
    throw new Error(`Unknown --targets value(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
  }
}
const TARGETS = selectedTargets
  ? ALL_TARGETS.filter((t) => selectedTargets.includes(t.archiveName))
  : ALL_TARGETS;

// Signing identity: explicit flag > env var > ad-hoc. Mirrors the resolution
// order in packages/encryption-binary-swift/scripts/build-swift.ts.
const signingIdentity = getArg('--sign') ?? process.env.APPLE_SIGNING_IDENTITY;
// Escape hatch: hardened runtime blocks debugger attach, so a local build you
// want to step through needs --no-sign
const skipSigning = process.argv.includes('--no-sign');

// sha256sum is GNU coreutils; macOS ships shasum instead
const SHA256_CMD = process.platform === 'darwin' ? 'shasum -a 256' : 'sha256sum';

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

/**
 * Developer ID sign the CLI binary with hardened runtime enabled.
 *
 * Only the `varlock` Mach-O is signed. The VarlockEnclave.app sitting next to it
 * is already signed and notarized by the native-binary workflow, and re-signing
 * it here would invalidate its stapled ticket, hence no `--deep`.
 *
 * Hardened runtime is the point of this, not a formality: without it (or with
 * `get-task-allow` granted) any process running as the same user can attach to
 * varlock and read resolved secrets straight out of its memory.
 *
 * varlock-cli.entitlements lists every hardened-runtime exception as `<false/>`
 * rather than omitting them, so a future edit that flips one shows up in the
 * diff. Bun's codesigning guide suggests granting allow-jit,
 * allow-unsigned-executable-memory, disable-executable-page-protection,
 * allow-dyld-environment-variables, and disable-library-validation; none are
 * actually needed. The compiled binary was verified to run under
 * `--options runtime` with an empty entitlement set, including the path that
 * spawns VarlockEnclave.app and talks to it over its unix socket. Note that the
 * entitlements plist cannot carry XML comments: codesign feeds it to
 * AMFIUnserializeXML, which rejects them.
 */
function signMacBinary(binPath: string) {
  if (skipSigning) {
    console.log('  Skipping codesign (--no-sign)');
    return;
  }
  if (process.platform !== 'darwin') {
    console.log('  Skipping codesign (not running on macOS)');
    return;
  }
  if (!fs.existsSync(ENTITLEMENTS)) {
    throw new Error(`Entitlements file not found at ${ENTITLEMENTS}`);
  }

  if (signingIdentity) {
    console.log(`  Signing ${path.basename(binPath)} with "${signingIdentity}"`);
    exec(`codesign --force --options runtime --timestamp --entitlements "${ENTITLEMENTS}" --sign "${signingIdentity}" "${binPath}"`);
  } else {
    console.log(`  Ad-hoc signing ${path.basename(binPath)} (set APPLE_SIGNING_IDENTITY for a real signature)`);
    exec(`codesign --force --options runtime --entitlements "${ENTITLEMENTS}" --sign - "${binPath}"`);
  }
  exec(`codesign --verify --strict --verbose=2 "${binPath}"`);
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
    // Ad-hoc sign with hardened runtime so the local binary has the same runtime
    // posture as a release build
    signMacBinary(path.join(PKG_DIR, DIST_DIR, binName));

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
  // Build for all selected platforms and create archives
  for (const { bunTarget, archiveName } of TARGETS) {
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

    // Sign before archiving. codesign happily signs a cross-compiled x64 Mach-O
    // from an arm64 host, so both macOS archives can be signed in one job.
    if (archiveName.startsWith('macos-')) {
      signMacBinary(path.join(PKG_DIR, targetDir, binName));
    }

    // Bundle platform-specific native binaries alongside the CLI binary
    if (!skipNative) {
      const isMac = archiveName.startsWith('macos-');
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
      // COPYFILE_DISABLE stops bsdtar (macOS) from emitting ._* AppleDouble
      // sidecars for the signed .app; a no-op for GNU tar on linux
      archiveCmd = `COPYFILE_DISABLE=1 tar --gzip -cf ${DIST_DIR}/${archive} -C ${targetDir}/ .`;
    }
    exec(archiveCmd);
    execSync(`${SHA256_CMD} ${archive} >> checksums.txt`, {
      cwd: path.join(PKG_DIR, DIST_DIR),
    });
  }

  // Print size summary for all archives
  console.log('\n=== Release archive size summary ===');
  let totalBytes = 0;
  for (const { archiveName } of TARGETS) {
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
