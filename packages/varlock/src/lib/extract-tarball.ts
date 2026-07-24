import path from 'node:path';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

/**
 * Native extraction of a gzipped tarball (`.tgz`), with no dependency on a
 * `tar` binary or a shell to spawn one.
 *
 * This exists so plugin auto-install works in minimal/distroless container
 * images that ship neither `/bin/sh` nor `tar`. `node:zlib` is available in
 * both Node and Bun (including the compiled SEA binary), so this runs
 * everywhere varlock does.
 *
 * We only support the subset of the tar format that npm-published tarballs
 * actually use: regular files and directories, plus PAX / GNU long-name
 * extended headers so deeply-nested paths still extract correctly. Symlinks,
 * hardlinks, and device nodes are skipped.
 */

const BLOCK_SIZE = 512;

/** Read a NUL-terminated (or field-length-bounded) ASCII string from a header field. */
function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.toString('utf-8', 0, nul === -1 ? length : nul);
}

/**
 * Read a tar numeric field. Standard tar stores these as NUL/space-terminated
 * octal ASCII. GNU tar uses base-256 (high bit of the first byte set) for
 * values too large for the octal field; we handle that too, just in case.
 */
function readNumeric(block: Buffer, offset: number, length: number): number {
  const first = block[offset];
  if (first >= 0x80) {
    // GNU base-256 encoding: high bit of the first byte is a flag, not a value bit
    let value = first - 0x80;
    for (let i = 1; i < length; i++) {
      value = (value * 256) + block[offset + i];
    }
    return value;
  }
  const str = readString(block, offset, length).trim();
  if (!str) return 0;
  const parsed = parseInt(str, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Parse PAX extended-header records ("<len> key=value\n") into a key/value map. */
function parsePaxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let pos = 0;
  const text = data.toString('utf-8');
  while (pos < text.length) {
    const spaceIdx = text.indexOf(' ', pos);
    if (spaceIdx === -1) break;
    const len = parseInt(text.slice(pos, spaceIdx), 10);
    if (Number.isNaN(len) || len <= 0) break;
    const record = text.slice(spaceIdx + 1, pos + len - 1); // drop trailing "\n"
    const eq = record.indexOf('=');
    if (eq !== -1) {
      records[record.slice(0, eq)] = record.slice(eq + 1);
    }
    pos += len;
  }
  return records;
}

/**
 * Resolve an entry path against the destination directory, refusing anything
 * that would escape it (absolute paths, `..` traversal). Mirrors what `tar`
 * does by default and blocks tarball path-traversal attacks.
 */
function safeJoin(destDir: string, entryName: string): string | undefined {
  // strip a leading slash the way tar does, then normalize
  const normalized = entryName.replace(/^\/+/, '');
  const target = path.resolve(destDir, normalized);
  const rel = path.relative(destDir, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return target;
}

/** Extract a gzipped tar buffer into `destDir`. */
export async function extractTarballBuffer(tgzBuffer: Buffer, destDir: string): Promise<void> {
  const buf = zlib.gunzipSync(tgzBuffer);

  await fs.mkdir(destDir, { recursive: true });

  // overrides carried from a preceding PAX / GNU long-name header to the next entry
  let nextPath: string | undefined;
  let nextSize: number | undefined;

  let offset = 0;
  while (offset + BLOCK_SIZE <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK_SIZE);

    // two consecutive zero blocks mark end-of-archive; a single one is enough to stop
    if (header.every((b) => b === 0)) break;

    offset += BLOCK_SIZE;

    const rawName = readString(header, 0, 100);
    const size = readNumeric(header, 124, 12);
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const prefix = readString(header, 345, 155);

    const dataStart = offset;
    const dataEnd = dataStart + size;
    // advance past the data, rounded up to the next block boundary
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    // PAX extended header (per-file 'x' or global 'g') — records apply to the next entry
    if (typeflag === 'x' || typeflag === 'g') {
      const records = parsePaxRecords(buf.subarray(dataStart, dataEnd));
      if (records.path !== undefined) nextPath = records.path;
      if (records.size !== undefined) nextSize = parseInt(records.size, 10);
      continue;
    }

    // GNU long name / long link — data holds the full path for the next entry
    if (typeflag === 'L') {
      nextPath = buf.subarray(dataStart, dataEnd).toString('utf-8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'K') {
      continue; // long linkname — only relevant to links, which we skip anyway
    }

    const entryName = nextPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
    const entrySize = nextSize ?? size;
    nextPath = undefined;
    nextSize = undefined;

    if (!entryName) continue;

    // directory
    if (typeflag === '5' || entryName.endsWith('/')) {
      const dir = safeJoin(destDir, entryName);
      if (dir) await fs.mkdir(dir, { recursive: true });
      continue;
    }

    // regular file ('0' or legacy '\0'); skip links/devices/etc.
    if (typeflag === '0' || typeflag === '7') {
      const target = safeJoin(destDir, entryName);
      if (!target) continue; // refuse path traversal
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buf.subarray(dataStart, dataStart + entrySize));
    }
  }
}

/** Extract a gzipped tarball file at `tgzPath` into `destDir`. */
export async function extractTarball(tgzPath: string, destDir: string): Promise<void> {
  const tgzBuffer = await fs.readFile(tgzPath);
  await extractTarballBuffer(tgzBuffer, destDir);
}
