/**
 * Stages published @varlock/native-helper-* binaries into
 * packages/varlock/native-bins/<suffix>/, for builds that bundle the helpers
 * without rebuilding them (release CLI binaries when a helper is not being
 * released, re-cuts, previews).
 *
 * Helper versions are exact and npm versions are immutable, so a pinned version
 * is always the binary our release workflow published for it.
 *
 * Usage:
 *   bun run scripts/fetch-native-helpers.ts [--platforms darwin,linux-x64] [--varlock-version 1.2.3] [--wait]
 *
 *   --platforms        helper suffixes to fetch (default: all)
 *   --varlock-version  use the helper versions pinned by that published varlock
 *                      (default: the versions in packages/native-helpers/<suffix>/package.json)
 *   --wait             poll the registry until each version is visible (right after a publish)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBDIR_CONTENTS } from '../packages/native-helpers/platforms';

const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(MONOREPO_ROOT, 'packages/varlock/native-bins');

const args = process.argv.slice(2);
function getArg(name: string) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const platforms = getArg('--platforms')?.split(',').filter(Boolean) ?? Object.keys(SUBDIR_CONTENTS);
const varlockVersion = getArg('--varlock-version');
const wait = args.includes('--wait');

for (const p of platforms) {
  if (!SUBDIR_CONTENTS[p]) throw new Error(`unknown helper platform: ${p}`);
}

function npm(npmArgs: Array<string>, cwd?: string) {
  return execFileSync('npm', npmArgs, { cwd, encoding: 'utf-8' }).trim();
}

function waitForPublished(spec: string, attempts: number) {
  for (let i = 1; i <= attempts; i++) {
    if (spawnSync('npm', ['view', spec, 'version'], { encoding: 'utf-8' }).stdout.trim()) return;
    if (!wait) break;
    console.log(`waiting for ${spec} on npm (${i})...`);
    execFileSync('sleep', ['10']);
  }
  throw new Error(`${spec} not found on npm`);
}

let pinned: Record<string, string> | undefined;
if (varlockVersion) {
  waitForPublished(`varlock@${varlockVersion}`, 30);
  pinned = JSON.parse(npm(['view', `varlock@${varlockVersion}`, 'optionalDependencies', '--json']) || '{}');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-native-helpers-'));
for (const suffix of platforms) {
  const name = `@varlock/native-helper-${suffix}`;
  const version = pinned
    ? pinned[name]
    : JSON.parse(fs.readFileSync(path.join(MONOREPO_ROOT, 'packages/native-helpers', suffix, 'package.json'), 'utf-8')).version;
  if (!version) throw new Error(`varlock@${varlockVersion} does not pin ${name} (versions <= 1.16.x bundled the binaries in the varlock tarball)`);
  const spec = `${name}@${version}`;
  waitForPublished(spec, 30);

  const workDir = path.join(tmp, suffix);
  fs.mkdirSync(workDir);
  const [packed] = JSON.parse(npm(['pack', spec, '--json'], workDir));
  execFileSync('tar', ['-xzf', packed.filename], { cwd: workDir });

  const entry = SUBDIR_CONTENTS[suffix];
  const destDir = path.join(DEST, suffix);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(path.join(workDir, 'package', entry), path.join(destDir, entry), { recursive: true, verbatimSymlinks: true });
  // npm tarballs keep the mode bits, but be explicit about the executables
  const exe = suffix === 'darwin' ? path.join(destDir, entry, 'Contents/MacOS/varlock-local-encrypt') : path.join(destDir, entry);
  fs.chmodSync(exe, 0o755);
  console.log(`staged ${spec} -> ${path.relative(MONOREPO_ROOT, destDir)}/${entry}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
