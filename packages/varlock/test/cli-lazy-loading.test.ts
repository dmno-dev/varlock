import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  dirname, join, resolve, relative,
} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const ENTRY = join(PKG_DIR, 'dist/cli/cli-executable.js');

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
 * `test:ci` dependsOn `build` in turbo.json, so dist is present and current here.
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

/** Every chunk reachable from the entry without crossing a dynamic import. */
function staticClosure(entry: string): Array<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    queue.push(...staticImportsOf(f));
  }
  return [...seen];
}

/**
 * Original source files that went into a chunk, via its sourcemap. Release builds
 * null out vendor `sourcesContent` but keep every `sources` path, so this works
 * for dev and release output alike.
 */
function sourcesOf(chunk: string): Array<string> {
  const mapPath = `${chunk}.map`;
  if (!existsSync(mapPath)) return [];
  const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { sources?: Array<string> };
  return (map.sources ?? []).map((s) => relative(PKG_DIR, resolve(dirname(mapPath), s)));
}

describe('CLI startup bundle boundaries', () => {
  if (!existsSync(ENTRY)) {
    it('requires a build', () => {
      throw new Error(`${relative(PKG_DIR, ENTRY)} not found - run \`bun run build\` first`);
    });
    return;
  }

  const closure = staticClosure(ENTRY);
  const eagerSources = new Set(closure.flatMap(sourcesOf));

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
    const dynamic = [...entrySrc.matchAll(/import\(\s*['"]\.[^'"]*?([\w-]+)\.command-[A-Z0-9]+\.js['"]\s*\)/g)]
      .map((m) => m[1]);

    // every command registered in the entry should have a matching lazy loader
    const registered = [
      ...readFileSync(join(PKG_DIR, 'src/cli/cli-executable.ts'), 'utf8')
        .matchAll(/^subCommands\.set\('([^']+)'/gm),
    ].map((m) => m[1]);

    expect(registered.length).toBeGreaterThan(15);
    expect(dynamic.length).toBe(registered.length);
  });
});
