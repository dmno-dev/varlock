/*
  Tests for the patched ServerResponse leak scanner in its default mode (throw on leak),
  which is how auto-load, init-server, and the vite integration apply it.

  NOTE: patchGlobalServerResponse patches ServerResponse.prototype once per process and
  captures its options at patch time, so redactInsteadOfThrow mode is covered in a
  separate test file (vitest isolates files into separate workers).
*/
import zlib from 'node:zlib';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';

import { patchGlobalServerResponse } from '../patch-server-response';
import { resetRedactionMap } from '../env';
import { makeRand, randomChunks, writeChunks } from './fuzz-helpers';

const SECRET = 'super-secret-value-abc123';
const UNICODE_SECRET = 'super-sëcret-value-abc123';

const FAKE_GRAPH = {
  sources: [],
  settings: {},
  config: {
    SECRET_KEY: { value: SECRET, isSensitive: true },
    UNICODE_SECRET_KEY: { value: UNICODE_SECRET, isSensitive: true },
    PUBLIC_KEY: { value: 'public-value', isSensitive: false },
  },
} as any;

// filler makes the payload look like a real page (and compress into multiple
// flush blocks); the secret sits at the END so truncated prefixes decode clean
const htmlWithSecret = `<html><body>${'filler '.repeat(100)}leaked: ${SECRET}</body></html>`;
const htmlClean = `<html><body>${'filler '.repeat(100)}no secrets here</body></html>`;

function makeRes(headers: Record<string, string> = {}) {
  const req = new IncomingMessage(new Socket());
  req.url = '/test-url';
  const res = new ServerResponse(req);
  res.setHeader('content-type', 'text/html');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  return res;
}

async function gzipInTwoFlushes(input: Buffer, splitAt: number) {
  const gz = zlib.createGzip();
  const compressed: Array<Buffer> = [];
  gz.on('data', (chunk) => compressed.push(chunk));
  const first = await new Promise<Buffer>((resolve) => {
    gz.write(input.subarray(0, splitAt));
    gz.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve(Buffer.concat(compressed.splice(0))));
  });
  const second = await new Promise<Buffer>((resolve) => {
    gz.on('end', () => resolve(Buffer.concat(compressed)));
    gz.end(input.subarray(splitAt));
  });
  return [first, second] as const;
}

beforeAll(() => {
  resetRedactionMap(FAKE_GRAPH);
  patchGlobalServerResponse();
});

describe('patched ServerResponse.write - uncompressed', () => {
  it('throws when a sensitive value appears in a string chunk', () => {
    const res = makeRes();
    expect(() => res.write(htmlWithSecret)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('passes clean string chunks through', () => {
    const res = makeRes();
    expect(() => res.write(htmlClean)).not.toThrow();
  });

  it('throws when a sensitive value appears in a Buffer chunk', () => {
    const res = makeRes();
    expect(() => res.write(Buffer.from(htmlWithSecret))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('does not scan non-text content types', () => {
    const res = makeRes({ 'content-type': 'image/png' });
    expect(() => res.write(Buffer.from(htmlWithSecret))).not.toThrow();
  });
});

describe('patched ServerResponse.write - compressed', () => {
  it('detects a leak in a single complete gzip chunk', () => {
    const res = makeRes({ 'content-encoding': 'gzip' });
    expect(() => res.write(zlib.gzipSync(htmlWithSecret))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('passes a clean gzip response through', () => {
    const res = makeRes({ 'content-encoding': 'gzip' });
    expect(() => res.write(zlib.gzipSync(htmlClean))).not.toThrow();
  });

  it('detects a leak split across multiple gzip chunks', () => {
    const gz = zlib.gzipSync(htmlWithSecret);
    const res = makeRes({ 'content-encoding': 'gzip' });
    // truncated prefix decodes (partially or not at all) without the secret
    expect(() => res.write(gz.subarray(0, 20))).not.toThrow();
    expect(() => res.write(gz.subarray(20))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('tolerates a header-only first chunk', () => {
    const gz = zlib.gzipSync(htmlClean);
    const res = makeRes({ 'content-encoding': 'gzip' });
    expect(() => res.write(gz.subarray(0, 10))).not.toThrow(); // 10-byte gzip header only
    expect(() => res.write(gz.subarray(10))).not.toThrow();
  });

  it('detects a leak in a deflate response', () => {
    const res = makeRes({ 'content-encoding': 'deflate' });
    expect(() => res.write(zlib.deflateSync(htmlWithSecret))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('detects a leak in a brotli response', () => {
    const res = makeRes({ 'content-encoding': 'br' });
    expect(() => res.write(zlib.brotliCompressSync(htmlWithSecret))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('detects a leak split across multiple brotli chunks', () => {
    const br = zlib.brotliCompressSync(htmlWithSecret);
    const res = makeRes({ 'content-encoding': 'br' });
    expect(() => res.write(br.subarray(0, 20))).not.toThrow();
    expect(() => res.write(br.subarray(20))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  const hasZstd = typeof (zlib as any).zstdCompressSync === 'function';
  it.skipIf(!hasZstd)('detects a leak in a zstd response', () => {
    const res = makeRes({ 'content-encoding': 'zstd' });
    const compressed = (zlib as any).zstdCompressSync(Buffer.from(htmlWithSecret));
    expect(() => res.write(compressed)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('does not scan unsupported encodings (documented fail-open)', () => {
    const res = makeRes({ 'content-encoding': 'x-unknown' });
    expect(() => res.write(Buffer.from(htmlWithSecret))).not.toThrow();
  });
});

describe('patched ServerResponse.end', () => {
  it('throws when a sensitive value appears in a string end chunk', () => {
    const res = makeRes({ 'content-type': 'application/json' });
    expect(() => res.end(JSON.stringify({ leaked: SECRET }))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('throws when a sensitive value appears in a Buffer end chunk', () => {
    const res = makeRes({ 'content-type': 'application/json' });
    expect(() => res.end(Buffer.from(JSON.stringify({ leaked: SECRET })))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('finishes the response so the client does not hang when leak detection throws', () => {
    const res = makeRes({ 'content-type': 'application/json' });
    expect(() => res.end(JSON.stringify({ leaked: SECRET }))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
    expect(res.writableEnded || res.destroyed).toBe(true);
    expect(res.statusCode).toBe(500);
  });
});

// a scan that only ever sees one chunk at a time misses any value that straddles a boundary,
// which is the normal case for streaming SSR (chunks flush at arbitrary points)
describe('patched ServerResponse - sensitive values split across chunks', () => {
  const SPLIT_AT = 10;
  const head = SECRET.slice(0, SPLIT_AT);
  const tail = SECRET.slice(SPLIT_AT);

  it('detects a secret split across write() and end()', () => {
    const res = makeRes();
    expect(() => res.write(`<html>leaked: ${head}`)).not.toThrow();
    expect(() => res.end(`${tail}</html>`)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('detects a secret split across two write() calls', () => {
    const res = makeRes();
    expect(() => res.write(`<html>leaked: ${head}`)).not.toThrow();
    expect(() => res.write(`${tail}</html>`)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('detects a secret split across Buffer chunks', () => {
    const res = makeRes();
    expect(() => res.write(Buffer.from(`<html>leaked: ${head}`))).not.toThrow();
    expect(() => res.write(Buffer.from(`${tail}</html>`))).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('detects a secret written one character at a time', () => {
    const res = makeRes();
    const chars = SECRET.split('');
    const lastChar = chars.pop();
    for (const char of chars) {
      expect(() => res.write(char)).not.toThrow();
    }
    expect(() => res.write(lastChar)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('detects a secret split across gzip flush boundaries', async () => {
    const input = Buffer.from(`<html>leaked: ${SECRET}</html>`);
    const splitAt = Buffer.byteLength(`<html>leaked: ${head}`);
    // Z_SYNC_FLUSH ends the first block on a byte boundary, which is how a server
    // streaming a compressed response emits a chunk mid-body
    const [first, second] = await gzipInTwoFlushes(input, splitAt);

    const res = makeRes({ 'content-encoding': 'gzip' });
    // each half decompresses on its own without ever containing the whole secret
    expect(() => res.write(first)).not.toThrow();
    expect(() => res.write(second)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it.each(['write', 'end'] as const)(
    'detects a Unicode secret when a compressed delta ends mid-character before %s()',
    async (completionMethod) => {
      const input = Buffer.from(`<html>leaked: ${UNICODE_SECRET}</html>`);
      const splitAt = input.indexOf(Buffer.from('ë')) + 1;
      const [first, second] = await gzipInTwoFlushes(input, splitAt);
      const firstDecompressed = zlib.unzipSync(first, {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
      });
      expect(firstDecompressed.subarray(-1)).toEqual(Buffer.from('ë').subarray(0, 1));

      const res = makeRes({ 'content-encoding': 'gzip' });
      expect(() => res.write(first)).not.toThrow();
      expect(() => res[completionMethod](second)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
    },
  );

  it('does not false-positive on text that merely starts like a secret', () => {
    const res = makeRes();
    expect(() => res.write(`<html>${head}`)).not.toThrow();
    expect(() => res.end('-but-not-really</html>')).not.toThrow();
  });

  it('still detects the secret when its head was already flushed by the holdback timer', async () => {
    const res = makeRes();
    expect(() => res.write(`<html>leaked: ${head}`)).not.toThrow();
    // wait past the holdback window so the timer flushes the withheld head, which
    // moves it into `carry` - the completing chunk must still be caught there
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(() => res.write(`${tail}</html>`)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('reports success and fires the callback when a whole chunk is withheld', async () => {
    const res = makeRes();
    // the entire chunk is a possible secret prefix, so nothing goes out yet - but the
    // caller must still see a normal successful write or streams piping into the
    // response would stall waiting on the callback
    let cbFired = false;
    const returned = res.write(head, () => {
      cbFired = true;
    });
    expect(returned).toBe(true);
    await new Promise((resolve) => {
      process.nextTick(resolve);
    });
    expect(cbFired).toBe(true);
  });
});

/*
  Trailing text that looks like the start of a secret is withheld until the next chunk
  (so a split value can be caught before any of it is sent), which makes response
  integrity worth verifying over a real socket rather than a detached ServerResponse.
*/
describe('patched ServerResponse - pass-through integrity', () => {
  let server: http.Server;
  let baseUrl: string;
  /** resolves once the test has read the withheld text, so the handler can finish */
  let releaseSlowResponse: () => void;

  const partial = `${SECRET.slice(0, 12)}-not-a-secret`;
  const multibyte = 'héllo wörld 🔐 ünïcode';
  // multi-byte chars exercise the decoder-alignment paths, the lookalike exercises holdback
  const fuzzCleanText = `<html>héllo wörld 🔐 ünïcode ${'filler '.repeat(20)}${SECRET.slice(0, 12)}-lookalike</html>`;
  const fuzzLeakText = `<html>héllo 🔐 leak: ${SECRET} more ünïcode text</html>`;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/partial-lookalike') {
        // ends mid-lookalike, so the tail is withheld until end() flushes it
        res.write(`<html>${SECRET.slice(0, 12)}`);
        res.end('-not-a-secret</html>');
      } else if (req.url === '/multibyte') {
        // split a multi-byte character across two Buffer chunks
        const buf = Buffer.from(`<html>${multibyte}</html>`);
        const mid = 8; // lands inside the 2-byte é
        res.write(buf.subarray(0, mid));
        res.write(buf.subarray(mid));
        res.end();
      } else if (req.url === '/binary-then-string') {
        // a binary chunk ends mid-character and the rest arrives as strings - the held
        // bytes must flush in place (as a replacement char), not be dropped or reordered
        const buf = Buffer.from('<html>é');
        res.write(buf.subarray(0, buf.length - 1)); // ends with the é lead byte
        res.write('mid');
        res.end('tail</html>');
      } else if (req.url === '/lone-partial-lead') {
        // a binary chunk that is nothing but the start of a split character - its raw
        // bytes must not go out, or the flush on the next string chunk duplicates them
        res.write(Buffer.from('<html>'));
        res.write(Buffer.from([0xc3])); // é lead byte alone, decodes to ''
        res.end('mid</html>');
      } else if (req.url === '/invalid-lead-byte') {
        // 0xC0 is never a valid UTF-8 lead: the decoder replaces it immediately and holds
        // nothing, so the raw bytes must pass through untouched (no re-encode trigger)
        res.write(Buffer.concat([Buffer.from('<html>x'), Buffer.from([0xc0])]));
        res.end('</html>');
      } else if (req.url === '/withheld-then-bare-end') {
        // tail is withheld as a lookalike, and end() carries no chunk of its own -
        // the withheld text must still be flushed as the final chunk
        res.write(`<html>${SECRET.slice(0, 12)}`);
        res.end();
      } else if (req.url?.startsWith('/fuzz-clean')) {
        const seed = Number(new URL(req.url, 'http://localhost').searchParams.get('seed'));
        const rand = makeRand(seed);
        writeChunks(res, randomChunks(fuzzCleanText, rand), rand);
      } else if (req.url?.startsWith('/fuzz-leak')) {
        const seed = Number(new URL(req.url, 'http://localhost').searchParams.get('seed'));
        const rand = makeRand(seed);
        try {
          writeChunks(res, randomChunks(fuzzLeakText, rand), rand);
        } catch (err) {
          // leak detected mid-write - kill the response like a real server error path
          res.destroy();
        }
      } else if (req.url === '/slow-lookalike') {
        // pauses right after a partial match, so the held-back text must still be flushed
        res.write(`<html>${SECRET.slice(0, 12)}`);
        await new Promise<void>((resolve) => {
          releaseSlowResponse = resolve;
        });
        res.end('-not-a-secret</html>');
      } else {
        res.end('not found');
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected address info');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    releaseSlowResponse?.();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it('delivers withheld text once the response ends', async () => {
    const body = await (await fetch(`${baseUrl}/partial-lookalike`)).text();
    expect(body).toBe(`<html>${partial}</html>`);
  });

  it('delivers multi-byte characters split across chunks intact', async () => {
    const body = await (await fetch(`${baseUrl}/multibyte`)).text();
    expect(body).toBe(`<html>${multibyte}</html>`);
  });

  it('flushes held bytes in place when the response switches to string chunks', async () => {
    const body = await (await fetch(`${baseUrl}/binary-then-string`)).text();
    expect(body).toBe('<html>�midtail</html>');
  });

  it('does not emit a wholly-held binary chunk twice', async () => {
    const body = await (await fetch(`${baseUrl}/lone-partial-lead`)).text();
    expect(body).toBe('<html>�mid</html>');
  });

  it('passes invalid UTF-8 lead bytes through untouched', async () => {
    const resp = await fetch(`${baseUrl}/invalid-lead-byte`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    expect(bytes).toEqual(Buffer.concat([Buffer.from('<html>x'), Buffer.from([0xc0]), Buffer.from('</html>')]));
  });

  it('delivers withheld text when end() carries no chunk', async () => {
    const body = await (await fetch(`${baseUrl}/withheld-then-bare-end`)).text();
    expect(body).toBe(`<html>${SECRET.slice(0, 12)}`);
  });

  it('fuzz: random chunkings of a clean response arrive byte-for-byte intact', async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const resp = await fetch(`${baseUrl}/fuzz-clean?seed=${seed}`);
      const bytes = Buffer.from(await resp.arrayBuffer());
      expect(bytes.toString('utf8'), `seed ${seed}`).toBe(fuzzCleanText);
      expect(bytes.equals(Buffer.from(fuzzCleanText)), `seed ${seed}`).toBe(true);
    }
  });

  it('fuzz: random chunkings never deliver the secret (throw mode)', async () => {
    for (let seed = 1; seed <= 30; seed++) {
      let received = '';
      try {
        const resp = await fetch(`${baseUrl}/fuzz-leak?seed=${seed}`);
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
        }
      } catch (err) {
        // connection killed mid-response - whatever arrived is in `received`
      }
      expect(received.includes(SECRET), `seed ${seed}`).toBe(false);
    }
  });

  it('flushes withheld text without waiting for the response to end', async () => {
    const resp = await fetch(`${baseUrl}/slow-lookalike`);
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    // the handler will not call end() until we release it, so this only completes
    // if the held-back tail is flushed on its own
    while (!received.includes(SECRET.slice(0, 12))) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    expect(received).toContain(SECRET.slice(0, 12));
    releaseSlowResponse();
    await reader.cancel();
  });
});
