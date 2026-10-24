import { ParsedEnvSpecFile } from './classes.js';
export * from './classes.js';
export * from './updater';
export * from './expand';
// exported so tooling can classify unquoted scalars the same way the parser does
export { autoCoerce } from './helpers';

// @ts-ignore
import * as peggyParser from './grammar.js';

type Position = { offset: number; line: number; column: number };
type Location = { start: Position; end: Position };

/**
 * The grammar only knows about `\n`, so we normalize `\r\n` before parsing. That makes every
 * offset it reports an offset into the normalized text. This returns a function that maps such
 * an offset back to an offset into the original source (or undefined if nothing was normalized).
 * Line and column are the same in both, because a `\r\n` only ever ends a line.
 */
function createOffsetMapper(source: string): ((offset: number) => number) | undefined {
  // position (in normalized text) of the `\n` of every `\r\n` we collapsed
  const collapsedAt: Array<number> = [];
  let idx = source.indexOf('\r\n');
  while (idx !== -1) {
    collapsedAt.push(idx - collapsedAt.length);
    idx = source.indexOf('\r\n', idx + 2);
  }
  if (!collapsedAt.length) return undefined;

  // each collapsed newline before `offset` added one more character (the `\r`) to the original
  return (offset) => {
    let lo = 0;
    let hi = collapsedAt.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (collapsedAt[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return offset + lo;
  };
}

function remapLocation(loc: Location, mapOffset: (offset: number) => number) {
  loc.start = { ...loc.start, offset: mapOffset(loc.start.offset) };
  loc.end = { ...loc.end, offset: mapOffset(loc.end.offset) };
}

/** walks the parsed tree, remapping every `_location` once (some are shared between nodes) */
function remapTreeLocations(
  node: object,
  mapOffset: (offset: number) => number,
  seen: Set<object>,
) {
  if (seen.has(node)) return;
  seen.add(node);
  for (const [key, val] of Object.entries(node)) {
    if (!val || typeof val !== 'object') continue;
    if (key === '_location') {
      if (!seen.has(val)) {
        seen.add(val);
        remapLocation(val as Location, mapOffset);
      }
    } else {
      remapTreeLocations(val, mapOffset, seen);
    }
  }
}

/**
 * Parses the contents of an env-spec file. Line endings can be `\n` or `\r\n`.
 * All locations (on parsed nodes and on syntax errors) are in terms of the string passed in.
 */
export function parseEnvSpecDotEnvFile(source: string): ParsedEnvSpecFile {
  const mapOffset = createOffsetMapper(source);
  const normalized = mapOffset ? source.replaceAll('\r\n', '\n') : source;
  try {
    const parsed = peggyParser.parse(normalized) as ParsedEnvSpecFile;
    if (mapOffset) remapTreeLocations(parsed, mapOffset, new Set());
    return parsed;
  } catch (err) {
    if (mapOffset && (err as any)?.location) remapLocation((err as any).location, mapOffset);
    throw err;
  }
}
