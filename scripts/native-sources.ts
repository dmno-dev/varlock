/**
 * Native helper binary inputs, shared by PR preview gating, preview caching, and
 * the native bump check.
 *
 * The @varlock/native-helper-* packages are versioned independently of varlock
 * and only released when their binaries change. varlock pins them as exact
 * versions, so a varlock version always maps to one set of released binaries,
 * and a helper with no pending release is exactly what is on npm at its
 * package.json version.
 *
 * - `pending`: the side's helpers have a pending release (a bump file on this
 *   branch or on main). Previews of such a branch need preview builds of that
 *   side; everything else uses the published helpers.
 * - `touched`: whether this branch changes the sources or the build workflows
 *   relative to its merge base with origin/main. CI then test-builds that side,
 *   so a broken build is caught in its own PR instead of at release time.
 * - `key`: content hash of the sources and build workflows (git blob ids, so
 *   identical on every OS), used as the cache key for unsigned preview builds.
 *
 * Bump check: when this branch changes a side's sources, a bump file on this
 * branch must name one of that side's helpers (bump type `none` if the binary is
 * unaffected), otherwise the script fails. bumpy cannot enforce this itself: it
 * only maps changes inside a package's own directory, and the Swift / Rust
 * sources live in separate private packages.
 *
 * Releases never use the preview builds: they always build natives from source.
 *
 * Usage:
 *   bun run scripts/native-sources.ts
 *
 * Outputs (via GITHUB_OUTPUT if available), for each of `macos` and `rust`:
 *   <side>-pending=true|false  <side>-touched=true|false
 *   <side>-key=native-preview-<side>-v1-<sha256>
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const MONOREPO_ROOT = path.resolve(path.dirname(__filename), '..');

// Everything that can change a helper binary or its npm package. Bump the `v1`
// in the key prefix to invalidate preview caches when something outside these
// paths changes the output (runner image, Xcode, Rust toolchain).
const SHARED_INPUTS = [
  'packages/native-helpers/platforms.ts',
  'packages/native-helpers/prepack.ts',
  'packages/native-helpers/postpack.ts',
];
const EXCLUDES = [':(exclude,glob)**/*.md'];

export const NATIVE_SOURCES = {
  macos: [
    'packages/encryption-binary-swift',
    'packages/native-helpers/darwin',
    ...SHARED_INPUTS,
  ],
  rust: [
    'packages/encryption-binary-rust',
    'packages/native-helpers/linux-x64',
    'packages/native-helpers/linux-arm64',
    'packages/native-helpers/win32-x64',
    ...SHARED_INPUTS,
  ],
} as const;

export type NativeSide = keyof typeof NATIVE_SOURCES;

const BUILD_WORKFLOWS: Record<NativeSide, Array<string>> = {
  macos: ['.github/workflows/build-native-macos.yaml'],
  rust: ['.github/workflows/build-native-rust.yaml'],
};

function buildInputs(side: NativeSide) {
  return [...NATIVE_SOURCES[side], ...BUILD_WORKFLOWS[side]];
}

/** npm package suffixes (packages/native-helpers/<suffix>) of the helpers each side produces */
export const NATIVE_HELPER_SUFFIXES: Record<NativeSide, Array<string>> = {
  macos: ['darwin'],
  rust: ['linux-x64', 'linux-arm64', 'win32-x64'],
};

/** npm package names of the helpers each side produces */
export const NATIVE_HELPER_PACKAGES = Object.fromEntries(
  Object.entries(NATIVE_HELPER_SUFFIXES).map(([side, suffixes]) => [side, suffixes.map((s) => `@varlock/native-helper-${s}`)]),
) as Record<NativeSide, Array<string>>;

function git(args: Array<string>) {
  return execFileSync('git', args, { cwd: MONOREPO_ROOT, encoding: 'utf-8' });
}

export function nativeSourceKey(side: NativeSide) {
  const files = git(['ls-files', '-s', '--', ...buildInputs(side), ...EXCLUDES]);
  if (!files.trim()) throw new Error(`no tracked native ${side} inputs found`);
  const hash = crypto.createHash('sha256').update(files).digest('hex');
  return `native-preview-${side}-v1-${hash}`;
}

function refExists(ref: string) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: MONOREPO_ROOT }).status === 0;
}

function differs(fromRef: string, paths: Array<string>) {
  const diff = spawnSync('git', ['diff', '--quiet', fromRef, 'HEAD', '--', ...paths, ...EXCLUDES], { cwd: MONOREPO_ROOT });
  if (diff.status !== 0 && diff.status !== 1) throw new Error(`git diff failed: ${diff.stderr}`);
  return diff.status === 1;
}

function mergeBase() {
  if (!refExists('refs/remotes/origin/main')) return undefined;
  return git(['merge-base', 'refs/remotes/origin/main', 'HEAD']).trim();
}

/** `bumpy status --json`, which may exit non-zero with warnings but still print valid JSON */
export function readBumpyStatus(): { bumpFiles: Array<any>, releases: Array<any> } {
  let raw: string;
  try {
    raw = execSync('bunx @varlock/bumpy status --json 2>/dev/null', { cwd: MONOREPO_ROOT }).toString();
  } catch (execErr: any) {
    raw = execErr.stdout?.toString() ?? '';
  }
  // stdout may contain warning lines before the JSON, extract just the JSON
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : { bumpFiles: [], releases: [] };
}

function helperVersion(suffix: string, ref?: string) {
  const relPath = `packages/native-helpers/${suffix}/package.json`;
  const raw = ref ? git(['show', `${ref}:${relPath}`]) : fs.readFileSync(path.join(MONOREPO_ROOT, relPath), 'utf-8');
  return JSON.parse(raw).version as string;
}

// run as a script (not when imported by check-release-packages.ts)
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const status = readBumpyStatus();
  const base = mergeBase();
  const lines: Array<string> = [];
  const missingBumps: Array<NativeSide> = [];
  for (const side of Object.keys(NATIVE_SOURCES) as Array<NativeSide>) {
    const helpers = NATIVE_HELPER_PACKAGES[side];
    const pending = status.releases.some((r) => helpers.includes(r.name));
    const touched = base ? differs(base, buildInputs(side)) : false;
    const key = nativeSourceKey(side);
    console.log(`native ${side}: pending release=${pending} touched by branch=${touched} key=${key}`);
    lines.push(`${side}-pending=${pending}`, `${side}-touched=${touched}`, `${side}-key=${key}`);

    if (base && differs(base, [...NATIVE_SOURCES[side]])) {
      // only this branch's bump files count: one already on main (possibly `none`)
      // covers the change that added it, not this one
      const covered = status.bumpFiles.some(
        (bf) => bf.inCurrentBranch && bf.releases.some((r: any) => helpers.includes(r.name)),
      );
      // the version PR consumes the bump files and bumps the helper versions itself
      const versioning = NATIVE_HELPER_SUFFIXES[side].some((s) => helperVersion(s) !== helperVersion(s, base));
      if (!covered && !versioning) missingBumps.push(side);
    }
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);

  if (missingBumps.length) {
    for (const side of missingBumps) {
      const pkg = NATIVE_HELPER_PACKAGES[side][0];
      console.error([
        `Native ${side} sources changed on this branch, but no bump file names ${NATIVE_HELPER_PACKAGES[side].join(' / ')}.`,
        'The helpers are only released when bumped, so without one this change never ships. Add a bump file:',
        `  bunx @varlock/bumpy add --packages "${pkg}:patch" --message "<what changed>" --name "${side}-native-<change>"`,
        `Use "${pkg}:none" instead if the change does not affect the shipped binary.`,
      ].join('\n'));
    }
    process.exit(1);
  }
}
