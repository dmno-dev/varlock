import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import {
  describe, it, expect, afterEach,
} from 'vitest';
import { extractTarballBuffer } from '../extract-tarball';

const BLOCK = 512;

/** Build a single 512-byte ustar header block for the given entry. */
function makeHeader(name: string, size: number, typeflag: string, prefix = ''): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf-8');
  block.write('0000644', 100, 8, 'utf-8'); // mode
  block.write('0000000', 108, 8, 'utf-8'); // uid
  block.write('0000000', 116, 8, 'utf-8'); // gid
  block.write(size.toString(8).padStart(11, '0'), 124, 12, 'utf-8'); // size (octal)
  block.write('00000000000', 136, 12, 'utf-8'); // mtime
  block.write(typeflag, 156, 1, 'utf-8');
  block.write('ustar\0', 257, 6, 'utf-8');
  block.write('00', 263, 2, 'utf-8');
  if (prefix) block.write(prefix, 345, 155, 'utf-8');

  // checksum: sum of all bytes with the checksum field treated as spaces
  block.write('        ', 148, 8, 'utf-8');
  let sum = 0;
  for (const b of block) sum += b;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf-8');
  return block;
}

/** Pad a data buffer up to the next 512-byte boundary. */
function padToBlock(data: Buffer): Buffer {
  const rem = data.length % BLOCK;
  if (rem === 0) return data;
  return Buffer.concat([data, Buffer.alloc(BLOCK - rem)]);
}

type TarEntry = { name: string, content?: string, typeflag?: string, prefix?: string };

/** Assemble a set of entries into a raw (uncompressed) tar buffer. */
function makeTar(entries: Array<TarEntry | Buffer>): Buffer {
  const parts: Array<Buffer> = [];
  for (const entry of entries) {
    if (Buffer.isBuffer(entry)) {
      parts.push(entry); // pre-built header + data (for PAX/GNU cases)
      continue;
    }
    const content = entry.content ?? '';
    const data = Buffer.from(content, 'utf-8');
    parts.push(makeHeader(entry.name, entry.typeflag === '5' ? 0 : data.length, entry.typeflag ?? '0', entry.prefix));
    if (entry.typeflag !== '5' && data.length) parts.push(padToBlock(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive
  return Buffer.concat(parts);
}

/** Build a PAX extended-header block plus its data, followed by the real entry. */
function makePaxEntry(paxRecords: Record<string, string>, realName: string, content: string): Buffer {
  const recordsText = Object.entries(paxRecords).map(([k, v]) => {
    const body = ` ${k}=${v}\n`;
    // record length includes the digits of the length itself
    let len = body.length + 1;
    len = body.length + String(len).length;
    // iterate to a fixed point (length digits can change the count)
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    return `${len}${body}`;
  }).join('');
  const paxData = Buffer.from(recordsText, 'utf-8');
  const paxHeader = makeHeader('PaxHeader', paxData.length, 'x');
  const data = Buffer.from(content, 'utf-8');
  const fileHeader = makeHeader(realName, data.length, '0');
  return Buffer.concat([paxHeader, padToBlock(paxData), fileHeader, padToBlock(data)]);
}

function gzip(buf: Buffer): Buffer {
  return zlib.gzipSync(buf);
}

const tmpDirs: Array<string> = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varlock-tar-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('extractTarballBuffer', () => {
  it('extracts regular files with the package/ prefix like npm tarballs', async () => {
    const dest = await makeTmpDir();
    const tar = makeTar([
      { name: 'package/package.json', content: '{"name":"my-plugin"}' },
      { name: 'package/dist/plugin.js', content: 'module.exports = {};' },
    ]);
    await extractTarballBuffer(gzip(tar), dest);

    expect(await fs.readFile(path.join(dest, 'package/package.json'), 'utf-8')).toBe('{"name":"my-plugin"}');
    expect(await fs.readFile(path.join(dest, 'package/dist/plugin.js'), 'utf-8')).toBe('module.exports = {};');
  });

  it('creates nested directories from directory entries', async () => {
    const dest = await makeTmpDir();
    const tar = makeTar([
      { name: 'package/nested/deep/', typeflag: '5' },
      { name: 'package/nested/deep/file.txt', content: 'hi' },
    ]);
    await extractTarballBuffer(gzip(tar), dest);
    expect(await fs.readFile(path.join(dest, 'package/nested/deep/file.txt'), 'utf-8')).toBe('hi');
  });

  it('honors the ustar prefix field for long paths', async () => {
    const dest = await makeTmpDir();
    const tar = makeTar([{ name: 'file.js', prefix: 'package/some/long/prefixed/path', content: 'x' }]);
    await extractTarballBuffer(gzip(tar), dest);
    expect(await fs.readFile(path.join(dest, 'package/some/long/prefixed/path/file.js'), 'utf-8')).toBe('x');
  });

  it('applies a PAX path override to the following entry', async () => {
    const dest = await makeTmpDir();
    const longPath = `package/${'a'.repeat(120)}/deep.js`;
    const tar = makeTar([makePaxEntry({ path: longPath }, 'IGNORED_SHORT_NAME', 'pax-content')]);
    await extractTarballBuffer(gzip(tar), dest);
    expect(await fs.readFile(path.join(dest, longPath), 'utf-8')).toBe('pax-content');
  });

  it('applies a GNU long-name (L) header to the following entry', async () => {
    const dest = await makeTmpDir();
    const longPath = `package/${'b'.repeat(130)}/gnu.js`;
    const nameData = Buffer.from(`${longPath}\0`, 'utf-8');
    const gnuHeader = makeHeader('././@LongLink', nameData.length, 'L');
    const content = Buffer.from('gnu-content', 'utf-8');
    const fileHeader = makeHeader('IGNORED', content.length, '0');
    const tar = makeTar([Buffer.concat([gnuHeader, padToBlock(nameData), fileHeader, padToBlock(content)])]);
    await extractTarballBuffer(gzip(tar), dest);
    expect(await fs.readFile(path.join(dest, longPath), 'utf-8')).toBe('gnu-content');
  });

  it('refuses path traversal outside the destination', async () => {
    const dest = await makeTmpDir();
    const tar = makeTar([
      { name: '../escape.js', content: 'evil' },
      { name: 'package/ok.js', content: 'good' },
    ]);
    await extractTarballBuffer(gzip(tar), dest);

    // the traversal entry is skipped, the safe one still extracts
    await expect(fs.readFile(path.join(dest, '../escape.js'), 'utf-8')).rejects.toThrow();
    expect(await fs.readFile(path.join(dest, 'package/ok.js'), 'utf-8')).toBe('good');
  });

  it('strips a leading slash rather than writing to an absolute path', async () => {
    const dest = await makeTmpDir();
    const tar = makeTar([{ name: '/package/abs.js', content: 'rooted' }]);
    await extractTarballBuffer(gzip(tar), dest);
    expect(await fs.readFile(path.join(dest, 'package/abs.js'), 'utf-8')).toBe('rooted');
  });

  it('skips symlink entries without failing', async () => {
    const dest = await makeTmpDir();
    const tar = makeTar([
      { name: 'package/link', typeflag: '2' }, // symlink typeflag
      { name: 'package/real.js', content: 'real' },
    ]);
    await extractTarballBuffer(gzip(tar), dest);
    await expect(fs.stat(path.join(dest, 'package/link'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dest, 'package/real.js'), 'utf-8')).toBe('real');
  });
});
