import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  dirname, join, resolve, relative,
} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const ENTRY = join(PKG_DIR, 'dist/cli/cli-executable.mjs');
const ENTRY_SRC = join(PKG_DIR, 'src/cli/cli-executable.ts');

/**
 * The CLI entry must only ever parse command *specs* at startup - every command
 * implementation stays behind a dynamic import until that command actually runs.
 *
 * This is a property of the built bundle, not of the source, which is why it is
 * checked here rather than by reading `cli-executable.ts`. The bug this guards
 * against is silent: the entry previously did have `await import(...)` calls for
 * every command, but because it also statically imported each command module for
 * its spec, esbuild resolved those dynamic imports to stub chunks that merely
 * re-exported already-eagerly-loaded code. Every command still worked and every
 * other test still passed - the CLI just parsed the whole proxy subsystem on
 * `varlock --version`. A stray `import { x } from './commands/y.command'` in the
 * entry would reintroduce exactly that, so the assertion has to be made against
 * the artifact.
 *
 * `test:ci` dependsOn `build` in turbo.json, so dist is present and current when
 * this runs through turbo. Invoking vitest directly (including
 * `bun run --filter varlock test:ci`, which does not go through turbo) skips that
 * build, so the staleness guard below covers the case where dist predates the
 * source this compares it against.
 */

/** Static (non-dynamic) relative imports of a built chunk. */
function staticImportsOf(file: string): Array<string> {
  const src = readFileSync(file, 'utf8');
  const out: Array<string> = [];
  // `import ... from './x.js'` / `export ... from './x.js'` / bare `import './x.js'`.
  // Dynamic `import('./x.js')` is deliberately excluded - that is the whole point.
  const re = /(?:^|\n)\s*(?:import|export)(?:\s[^;'"]*?from)?\s*['"](\.[^'"]+)['"]/g;
  for (const m of src.matchAll(re)) out.push(resolve(dirname(file), m[1]));
  return out;
}

/**
 * Every chunk reachable from the entry without crossing a dynamic import.
 *
 * A static import target that is not on disk means the build is incomplete or
 * broken, so it is reported rather than skipped - silently dropping it would
 * shrink the closure and weaken every assertion made against it.
 */
function staticClosure(entry: string): { chunks: Array<string>, missing: Array<string> } {
  const seen = new Set<string>();
  const missing = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f) || missing.has(f)) continue;
    if (!existsSync(f)) {
      missing.add(f);
      continue;
    }
    seen.add(f);
    queue.push(...staticImportsOf(f));
  }
  return { chunks: [...seen], missing: [...missing] };
}

/**
 * Original source files that went into a chunk, via its sourcemap. Release builds
 * null out vendor `sourcesContent` but keep every `sources` path, so this works
 * for dev and release output alike.
 *
 * Returns `null` when the chunk ships no sourcemap. That is treated as a failure
 * rather than "no sources", because the whole check reads the build through its
 * maps: if sourcemaps were ever turned off, silently mapping every chunk to zero
 * sources would make the boundary assertions below pass while inspecting nothing.
 */
function sourcesOf(chunk: string): Array<string> | null {
  const mapPath = `${chunk}.map`;
  if (!existsSync(mapPath)) return null;
  const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { sources?: Array<string> };
  if (!Array.isArray(map.sources)) return null;
  // An empty `sources` is legitimate for the bundler's generated helper chunk
  // (__toESM/__commonJSMin/...), which has no original source and an empty `mappings`.
  return map.sources.map((s) => relative(PKG_DIR, resolve(dirname(mapPath), s)));
}

describe('CLI startup bundle boundaries', () => {
  if (!existsSync(ENTRY)) {
    it('requires a build', () => {
      throw new Error(`${relative(PKG_DIR, ENTRY)} not found - run \`bun run build\` first`);
    });
    return;
  }

  // The last check reads the registration list out of the entry's *source* and
  // looks for a matching chunk in the *built* entry, so a dist older than that
  // source is being compared against a build that predates it. A command added
  // since the last build then looks like one that was never made lazy, which
  // sends you hunting a bug that is not there. Say what actually happened.
  //
  // Only this one source file is checked, since it is the only one the
  // comparison reads: editing anything else in src does not invalidate it, and
  // making every edit turn this red would just be noise. Running through turbo
  // cannot trip it, because `test:ci` dependsOn `build` and a restored cache
  // writes its outputs fresh. Running vitest directly against a stale dist can.
  if (statSync(ENTRY).mtimeMs < statSync(ENTRY_SRC).mtimeMs) {
    it('requires a current build', () => {
      throw new Error([
        `${relative(PKG_DIR, ENTRY)} is older than ${relative(PKG_DIR, ENTRY_SRC)},`,
        'so this would check the command list against a stale bundle.',
        'Run `bun run build` (or `bun run test:ci` from the repo root, which builds first).',
      ].join('\n'));
    });
    return;
  }

  const { chunks, missing } = staticClosure(ENTRY);
  const unmapped = chunks.filter((c) => sourcesOf(c) === null).map((c) => relative(PKG_DIR, c)).sort();
  const eagerSources = new Set(chunks.flatMap((c) => sourcesOf(c) ?? []));

  it('can actually see into the build it is checking', () => {
    // Fail-closed guard for the checks below, which read the bundle through its
    // sourcemaps. Without this, dropping `sourcemap` from tsdown.config.ts would
    // turn both boundary assertions into no-ops that still report green.
    expect(missing.map((f) => relative(PKG_DIR, f)).sort(), [
      'These chunks are statically imported but missing from dist - the build is',
      'incomplete. Re-run `bun run build`.',
    ].join('\n')).toEqual([]);

    expect(unmapped, [
      'These chunks are reachable from the CLI entry but ship no usable sourcemap,',
      'so the boundary checks below cannot see what is inside them.',
      'Keep `sourcemap: true` in tsdown.config.ts.',
    ].join('\n')).toEqual([]);

    // positive control: the entry's own module must be visible through the maps
    expect(eagerSources.has('src/cli/cli-executable.ts')).toBe(true);
  });

  it('does not eagerly load any command implementation', () => {
    const eagerCommands = [...eagerSources]
      .filter((s) => /^src\/cli\/commands\/.*\.command\.ts$/.test(s))
      .sort();

    expect(eagerCommands, [
      'These command implementations are in the CLI entry\'s static import closure,',
      'so they are parsed on every `varlock` invocation (including `--version`).',
      'Import the spec from the sibling `*.command-spec.ts` instead, and keep the',
      'implementation behind the gunshi `lazy()` loader.',
    ].join('\n')).toEqual([]);
  });

  it('does not eagerly load the proxy or env-graph engines', () => {
    // Heavy subsystems only some commands need. They are reached through the
    // command implementations above, but also via helper modules that used to
    // pull the env-graph barrel in for a single error class or a type-only
    // annotation - hence a check that does not depend on the command boundary.
    const forbidden = [
      'src/proxy/runtime-proxy.ts',
      'src/env-graph/lib/env-graph.ts',
      'src/env-graph/lib/loader.ts',
      'src/env-graph/lib/config-item.ts',
    ];
    const leaked = forbidden.filter((f) => eagerSources.has(f)).sort();

    expect(leaked, [
      'These modules are parsed on every `varlock` invocation.',
      'Usually a helper reached from the entry imports the `env-graph` barrel for',
      'something small - prefer a type-only import, or a deep import of the leaf',
      'module that actually holds it.',
    ].join('\n')).toEqual([]);
  });

  it('keeps every registered command behind a dynamic import', () => {
    const entrySrc = readFileSync(ENTRY, 'utf8');
    // chunk names look like `<command>.command-<hash>.<ext>`. The hash alphabet and the
    // extension are bundler details, and a chunk can be referenced more than once, so
    // compare the set of command names rather than a count.
    const dynamic = new Set(
      [...entrySrc.matchAll(/import\(\s*['"]\.[^'"]*?([\w-]+)\.command-[A-Za-z0-9_-]+\.[cm]?js['"]\s*\)/g)]
        .map((m) => m[1]),
    );

    // every command registered in the entry should have a matching lazy loader
    const registered = new Set(
      [
        ...readFileSync(join(PKG_DIR, 'src/cli/cli-executable.ts'), 'utf8')
          .matchAll(/^subCommands\.set\('([^']+)'/gm),
      ].map((m) => m[1]),
    );

    expect(registered.size).toBeGreaterThan(15);
    expect(
      [...registered].filter((c) => !dynamic.has(c)).sort(),
      'These commands are registered but not loaded through a dynamic import, so they are parsed on every invocation.',
    ).toEqual([]);
  });
});
