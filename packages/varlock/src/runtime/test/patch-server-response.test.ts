/*
  Tests for the patched ServerResponse leak scanner in its default mode (throw on leak),
  which is how auto-load, init-server, and the vite integration apply it.

  NOTE: patchGlobalServerResponse patches ServerResponse.prototype once per process and
  captures its options at patch time, so redactInsteadOfThrow mode is covered in a
  separate test file (vitest isolates files into separate workers).
*/
import http, { IncomingMessage, ServerResponse } from 'node:http';
import zlib from 'node:zlib';
import { Socket } from 'node:net';
import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';

import { patchGlobalServerResponse } from '../patch-server-response';
import { resetRedactionMap } from '../env';

const SECRET = 'super-secret-value-abc123';

const FAKE_GRAPH = {
  sources: [],
  settings: {},
  config: {
    SECRET_KEY: { value: SECRET, isSensitive: true },
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

let endServer: http.Server;
let endBaseUrl: string;

beforeAll(async () => {
  resetRedactionMap(FAKE_GRAPH);
  patchGlobalServerResponse();

  // Real HTTP server so we can assert end-leak responses finish (no hang)
  endServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      if (req.url === '/end-string-leak') {
        res.end(JSON.stringify({ leaked: SECRET }));
      } else if (req.url === '/end-buffer-leak') {
        res.end(Buffer.from(JSON.stringify({ leaked: SECRET })));
      } else if (req.url === '/end-after-headers') {
        res.write(JSON.stringify({ ok: true }));
        res.end(JSON.stringify({ leaked: SECRET }));
      } else {
        res.end('not found');
      }
    } catch {
      // patched end finishes the response before rethrowing; catch so the
      // server handler does not become an uncaught exception
    }
  });
  await new Promise<void>((resolve) => {
    endServer.listen(0, () => resolve());
  });
  const address = endServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected address info');
  }
  endBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    endServer.close((err) => (err ? reject(err) : resolve()));
  });
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

  it('finishes the HTTP response with 500 when end detects a string leak (no hang)', async () => {
    const resp = await fetch(`${endBaseUrl}/end-string-leak`);
    expect(resp.status).toBe(500);
    const body = await resp.text();
    expect(body).not.toContain(SECRET);
    expect(body).toBe('Internal Server Error');
  });

  it('finishes the HTTP response with 500 when end detects a Buffer leak (no hang)', async () => {
    const resp = await fetch(`${endBaseUrl}/end-buffer-leak`);
    expect(resp.status).toBe(500);
    const body = await resp.text();
    expect(body).not.toContain(SECRET);
    expect(body).toBe('Internal Server Error');
  });

  it('destroys the connection when headers were already sent before an end leak', async () => {
    let failed = false;
    let body = '';
    try {
      const resp = await fetch(`${endBaseUrl}/end-after-headers`);
      body = await resp.text();
    } catch {
      failed = true;
    }
    // connection destroyed mid-response: fetch may error or return a truncated body
    expect(failed || !body.includes(SECRET)).toBe(true);
    expect(body).not.toContain(SECRET);
  });
});
