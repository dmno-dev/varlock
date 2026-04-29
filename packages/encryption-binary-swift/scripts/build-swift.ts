#!/usr/bin/env bun

/**
 * Build script for the VarlockEnclave Swift binary.
 *
 * Two-phase build:
 *   1. Compile — produces a universal (or single-arch) binary. This is the slow
 *      step and is cached in CI by source hash.
 *   2. Bundle — wraps the binary in a .app bundle with environment-specific
 *      metadata (name, version, bundle ID) and codesigns it. This is fast and
 *      can vary per build mode without recompiling.
 *
 * Usage:
 *   bun run scripts/build-swift.ts                    # dev build (current arch)
 *   bun run scripts/build-swift.ts --universal        # universal binary (CI)
 *   bun run scripts/build-swift.ts --mode release     # production bundle metadata
 *   bun run scripts/build-swift.ts --sign "Developer ID Application: ..."
 *   bun run scripts/build-swift.ts --version 1.2.3    # set bundle version
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import 'varlock/auto-load';

// ── CLI args ────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const universal = args.includes('--universal');
const signingIdentity = getArg('--sign');
const mode = (getArg('--mode') ?? 'dev') as 'dev' | 'preview' | 'release';
const version = getArg('--version') ?? (() => {
  // Read the version from varlock's package.json so the .app bundle
  // has a meaningful CFBundleVersion even when --version is not passed
  try {
    const pkgPath = path.resolve(import.meta.dir, '..', '..', 'varlock', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
})();

// ── Paths ───────────────────────────────────────────────────────

const swiftDir = path.resolve(import.meta.dir, '..', 'swift');
const binDir = path.resolve(import.meta.dir, '..', '..', 'varlock', 'native-bins', 'darwin');
const binaryName = 'varlock-local-encrypt';
const appBundleName = 'VarlockEnclave.app';

// ── Build mode config ───────────────────────────────────────────

interface BundleConfig {
  bundleId: string;
  displayName: string;
  menuTitle: string;
}

const BUNDLE_CONFIGS: Record<string, BundleConfig> = {
  dev: {
    bundleId: 'dev.varlock.enclave.dev',
    displayName: 'Varlock (Dev)',
    menuTitle: 'Varlock Enclave (Dev)',
  },
  preview: {
    bundleId: 'dev.varlock.enclave.preview',
    displayName: 'Varlock (Preview)',
    menuTitle: 'Varlock Enclave (Preview)',
  },
  release: {
    bundleId: 'dev.varlock.enclave',
    displayName: 'Varlock',
    menuTitle: 'Varlock Secure Enclave',
  },
};

const bundleConfig = BUNDLE_CONFIGS[mode];
console.log(`Build mode: ${mode}`);
console.log(`Bundle ID: ${bundleConfig.bundleId}`);
console.log(`Display name: ${bundleConfig.displayName}`);

function run(cmd: string, opts?: { cwd?: string }) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: opts?.cwd ?? swiftDir });
}

// ── Phase 1: Compile ────────────────────────────────────────────

fs.mkdirSync(binDir, { recursive: true });

let builtBinaryPath: string;

if (universal) {
  // Build universal binary (arm64 + x86_64) — used in CI
  run('swift build -c release --arch arm64');
  run('swift build -c release --arch x86_64');

  const arm64Binary = path.join(swiftDir, '.build', 'arm64-apple-macosx', 'release', 'VarlockEnclave');
  const x86Binary = path.join(swiftDir, '.build', 'x86_64-apple-macosx', 'release', 'VarlockEnclave');

  builtBinaryPath = path.join(binDir, `${binaryName}-universal`);
  run(`lipo -create "${arm64Binary}" "${x86Binary}" -output "${builtBinaryPath}"`);
  run(`lipo -info "${builtBinaryPath}"`);
} else {
  // Current platform only — fast for local dev
  run('swift build -c release');
  builtBinaryPath = path.join(swiftDir, '.build', 'release', 'VarlockEnclave');
}

// ── Phase 2: Bundle ─────────────────────────────────────────────

const appDir = path.join(binDir, appBundleName);
const contentsDir = path.join(appDir, 'Contents');
const macosDir = path.join(contentsDir, 'MacOS');
const resourcesDir = path.join(contentsDir, 'Resources');

// Clean previous bundle
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(macosDir, { recursive: true });
fs.mkdirSync(resourcesDir, { recursive: true });

// Copy binary into bundle
const bundleBinaryPath = path.join(macosDir, binaryName);
fs.copyFileSync(builtBinaryPath, bundleBinaryPath);
fs.chmodSync(bundleBinaryPath, 0o755);

// Clean up temp universal binary if we created one
if (universal) {
  fs.unlinkSync(builtBinaryPath);
}

// Copy icon if it exists
const iconSrc = path.join(import.meta.dir, '..', 'resources', 'AppIcon.icns');
const hasIcon = fs.existsSync(iconSrc);
if (hasIcon) {
  fs.copyFileSync(iconSrc, path.join(resourcesDir, 'AppIcon.icns'));
}

// Copy menu bar icon PDFs
const menuIconsDir = path.join(import.meta.dir, '..', 'resources');
for (const iconName of ['varlock-menu-locked.pdf', 'varlock-menu-unlocked.pdf']) {
  const src = path.join(menuIconsDir, iconName);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(resourcesDir, iconName));
  }
}

// Write Info.plist with environment-specific metadata
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>${bundleConfig.bundleId}</string>
    <key>CFBundleName</key>
    <string>${bundleConfig.displayName}</string>
    <key>CFBundleDisplayName</key>
    <string>${bundleConfig.displayName}</string>
    <key>CFBundleExecutable</key>
    <string>${binaryName}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>${version}</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
    <key>LSUIElement</key>
    <true/>${hasIcon ? `
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>` : ''}
    <key>VarlockBuildMode</key>
    <string>${mode}</string>
    <key>VarlockMenuTitle</key>
    <string>${bundleConfig.menuTitle}</string>
</dict>
</plist>`;

fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlist);

console.log(`Built app bundle: ${appDir}`);

// ── Codesign ────────────────────────────────────────────────────

const entitlementsPath = path.resolve(import.meta.dir, '..', 'VarlockEnclave.entitlements');

// Resolve signing identity: explicit flag > APPLE_SIGNING_IDENTITY env var > ad-hoc
const resolvedIdentity = signingIdentity ?? process.env.APPLE_SIGNING_IDENTITY;

if (resolvedIdentity) {
  run(`codesign --force --deep --options runtime --entitlements "${entitlementsPath}" --sign "${resolvedIdentity}" "${appDir}"`);
  run(`codesign --verify --verbose "${appDir}"`);
  console.log('App bundle signed successfully');
} else {
  run(`codesign --force --deep --entitlements "${entitlementsPath}" --sign - "${appDir}"`);
  console.log('App bundle ad-hoc signed (set APPLE_SIGNING_IDENTITY for stable signing)');
}

console.log('Done!');
