/**
 * Post-build sourcemap slimmer for the published package.
 *
 * Our release sourcemaps embed `sourcesContent` for every input, including all
 * bundled third-party code (semver, ansis, asn1js, ...). That vendor source text
 * is dead weight in the npm tarball: nobody debugs varlock by stepping through a
 * dependency's bundled source, and stack traces still resolve to
 * `node_modules/.../foo.js:line` from the `mappings` alone.
 *
 * This nulls out `sourcesContent` for any source under `node_modules`, while
 * keeping:
 *  - all `sources` paths and `mappings` (so every frame, vendor included, still
 *    maps to the correct file and line), and
 *  - embedded content for our own workspace source (so debugging varlock's code
 *    still shows real source inline).
 *
 * Run standalone (`bun run scripts/strip-vendor-sourcemap-content.ts [dir]`) or
 * via tsup's onSuccess on release builds. Idempotent: entries already nulled stay
 * nulled.
 */
import {
  readdir, readFile, writeFile, stat,
} from 'node:fs/promises';
import { join } from 'node:path';

async function* walkMapFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist (e.g. nothing built yet) — nothing to do
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMapFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      yield full;
    }
  }
}

function isVendorSource(source: string): boolean {
  return source.includes('node_modules');
}

async function stripFile(mapPath: string): Promise<number> {
  const before = (await stat(mapPath)).size;
  let map: {
    sources?: Array<string>;
    sourcesContent?: Array<string | null>;
  };
  try {
    map = JSON.parse(await readFile(mapPath, 'utf8'));
  } catch {
    return 0; // not a JSON sourcemap — leave it alone
  }

  const { sources, sourcesContent } = map;
  if (!Array.isArray(sources) || !Array.isArray(sourcesContent)) return 0;

  let stripped = false;
  for (let i = 0; i < sources.length; i++) {
    if (sourcesContent[i] != null && isVendorSource(sources[i] ?? '')) {
      sourcesContent[i] = null;
      stripped = true;
    }
  }
  if (!stripped) return 0;

  await writeFile(mapPath, JSON.stringify(map));
  const after = (await stat(mapPath)).size;
  return Math.max(0, before - after);
}

async function main() {
  const dir = process.argv[2] ?? join(import.meta.dir, '..', 'dist');
  let totalSaved = 0;
  let touched = 0;
  for await (const mapPath of walkMapFiles(dir)) {
    const saved = await stripFile(mapPath);
    if (saved > 0) {
      totalSaved += saved;
      touched++;
    }
  }
  const mb = (totalSaved / 1e6).toFixed(2);
  console.log(`[strip-vendor-sourcemap-content] trimmed ${touched} map(s), saved ~${mb}MB of vendor sourcesContent`);
}

await main();
