#!/usr/bin/env node
// Builds the bundled @env-spec language server and publishes it as a GitHub
// release asset that the Zed extension downloads at runtime.
//
// Usage:
//   node packages/zed-plugin/scripts/release.mjs            # tag = v<extension.toml version>
//   node packages/zed-plugin/scripts/release.mjs 0.1.1      # explicit version (bumps all version pins)
//
// Requires: gh CLI authenticated, repo `dmno-dev/varlock` to exist.

import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO = 'dmno-dev/varlock';
const ASSET_NAME = 'env-spec-language-server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = join(root, 'server');
const extensionTomlPath = join(root, 'extension.toml');
const cargoTomlPath = join(root, 'Cargo.toml');
const cargoLockPath = join(root, 'Cargo.lock');
const rustPath = join(root, 'src', 'lib.rs');
const pkgPath = join(serverDir, 'package.json');
const lockPath = join(serverDir, 'package-lock.json');

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    stdio: 'inherit',
    cwd: root,
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`\nERROR command failed: ${cmd}`);
    process.exit(r.status ?? 1);
  }
}

function capture(cmd) {
  const r = spawnSync(cmd, {
    shell: true,
    cwd: root,
    encoding: 'utf8',
  });
  return {
    status: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
  };
}

function readExtensionVersion() {
  const extensionToml = readFileSync(extensionTomlPath, 'utf8');
  const match = extensionToml.match(/^version = "([^"]+)"$/m);
  if (!match) {
    console.error('\nERROR failed to find version in extension.toml');
    process.exit(1);
  }
  return match[1];
}

function readReleaseTag() {
  const rust = readFileSync(rustPath, 'utf8');
  const match = rust.match(/^const RELEASE_TAG: &str = "([^"]+)";$/m);
  if (!match) {
    console.error('\nERROR failed to find RELEASE_TAG in src/lib.rs');
    process.exit(1);
  }
  return match[1];
}

function readCargoVersion() {
  const cargoToml = readFileSync(cargoTomlPath, 'utf8');
  const match = cargoToml.match(/^version = "([^"]+)"$/m);
  if (!match) {
    console.error('\nERROR failed to find version in Cargo.toml');
    process.exit(1);
  }
  return match[1];
}

function readCargoLockVersion() {
  const cargoLock = readFileSync(cargoLockPath, 'utf8');
  const match = cargoLock.match(
    /\[\[package\]\]\nname = "varlock_env_spec_zed"\nversion = "([^"]+)"/,
  );
  if (!match) {
    console.error('\nERROR failed to find varlock_env_spec_zed version in Cargo.lock');
    process.exit(1);
  }
  return match[1];
}

function writeExtensionVersion(version) {
  const extensionToml = readFileSync(extensionTomlPath, 'utf8');
  writeFileSync(
    extensionTomlPath,
    extensionToml.replace(/^version = "[^"]+"$/m, `version = "${version}"`),
  );
}

function writeServerPackageVersion(pkg, version) {
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function writeRustVersions(version) {
  let cargoToml = readFileSync(cargoTomlPath, 'utf8');
  cargoToml = cargoToml.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  writeFileSync(cargoTomlPath, cargoToml);

  let cargoLock = readFileSync(cargoLockPath, 'utf8');
  cargoLock = cargoLock.replace(
    /(\[\[package\]\]\nname = "varlock_env_spec_zed"\n)version = "[^"]+"/,
    `$1version = "${version}"`,
  );
  writeFileSync(cargoLockPath, cargoLock);

  let rust = readFileSync(rustPath, 'utf8');
  rust = rust.replace(
    /^const RELEASE_TAG: &str = "v[^"]+";$/m,
    `const RELEASE_TAG: &str = "v${version}";`,
  );
  writeFileSync(rustPath, rust);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const argVersion = process.argv[2];
if (argVersion) {
  writeExtensionVersion(argVersion);
  writeServerPackageVersion(pkg, argVersion);
  writeRustVersions(argVersion);
  console.log(`* bumped extension, Rust crate, and server version to ${argVersion}`);
}

const version = readExtensionVersion();
if (pkg.version !== version) {
  console.error(
    `\nERROR version mismatch: extension.toml is ${version}, server/package.json is ${pkg.version}`,
  );
  console.error('  Run: node scripts/release.mjs <version>');
  process.exit(1);
}

const tag = `v${version}`;
const cargoVersion = readCargoVersion();
if (cargoVersion !== version) {
  console.error(
    `\nERROR version mismatch: extension.toml is ${version}, Cargo.toml is ${cargoVersion}`,
  );
  console.error('  Run: node scripts/release.mjs <version>');
  process.exit(1);
}

const cargoLockVersion = readCargoLockVersion();
if (cargoLockVersion !== version) {
  console.error(
    `\nERROR version mismatch: extension.toml is ${version}, Cargo.lock is ${cargoLockVersion}`,
  );
  console.error('  Run: node scripts/release.mjs <version>');
  process.exit(1);
}

const releaseTag = readReleaseTag();
if (releaseTag !== tag) {
  console.error(
    `\nERROR version mismatch: extension.toml is ${version}, src/lib.rs uses ${releaseTag}`,
  );
  console.error('  Run: node scripts/release.mjs <version>');
  process.exit(1);
}

console.log(`* building bundled language server (${tag})`);
run('npm --prefix server run build');

const stageDir = mkdtempSync(join(tmpdir(), 'envspec-release-'));
const assetPath = join(stageDir, ASSET_NAME);
copyFileSync(join(serverDir, 'out', 'server.js'), assetPath);

const exists = capture(`gh release view ${tag} --repo ${REPO}`).status === 0;
if (exists) {
  console.log(`* release ${tag} exists - replacing asset`);
  run(`gh release upload ${tag} "${assetPath}" --repo ${REPO} --clobber`);
} else {
  console.log(`* creating release ${tag}`);
  run(
    `gh release create ${tag} "${assetPath}" --repo ${REPO} `
      + `--title '@env-spec language server ${tag}' `
      + '--notes "Bundled language server for the Varlock Schema Zed extension."',
  );
}

rmSync(stageDir, { recursive: true, force: true });
console.log(`\nOK published ${ASSET_NAME} to ${REPO} @ ${tag}`);
console.log('  Now rebuild the dev extension in Zed so it re-syncs to the remote.');
