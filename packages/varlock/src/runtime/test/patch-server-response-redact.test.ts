/*
  Tests for the patched ServerResponse leak scanner in redactInsteadOfThrow mode
  (how the nextjs integration applies it in dev), exercised through a real HTTP
  server so pass-through integrity is verified end-to-end.

  Kept separate from patch-server-response.test.ts because the prototype patch
  captures its options once per process (vitest isolates files into separate workers).
*/
import http from 'node:http';
import zlib from 'node:zlib';
import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';

import { patchGlobalServerResponse } from '../patch-server-response';
import { resetRedactionMap } from '../env';

const SECRET = 'redact-mode-secret-xyz789';

const FAKE_GRAPH = {
  sources: [],
  settings: {},
  config: {
    SECRET_KEY: { value: SECRET, isSensitive: true },
  },
} as any;

const htmlClean = `<html><body>${'filler '.repeat(100)}no secrets here</body></html>`;
const htmlWithSecret = `<html><body>leak: ${SECRET}</body></html>`;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  resetRedactionMap(FAKE_GRAPH);
  patchGlobalServerResponse({ redactInsteadOfThrow: true });

  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/string-leak') {
      res.write(htmlWithSecret);
      res.end();
    } else if (req.url === '/gzip-clean') {
      res.setHeader('content-encoding', 'gzip');
      const gz = zlib.gzipSync(htmlClean);
      // write in two chunks to exercise incremental decode + pass-through
      res.write(gz.subarray(0, 15));
      res.write(gz.subarray(15));
      res.end();
    } else if (req.url === '/gzip-leak') {
      res.setHeader('content-encoding', 'gzip');
      try {
        res.write(zlib.gzipSync(htmlWithSecret));
        res.end();
      } catch (err) {
        // compressed chunks can't be scrubbed, so the patched write fails closed —
        // kill the connection like a framework's error handling would
        res.destroy();
      }
    } else {
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected address info');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
  });
});

describe('patchGlobalServerResponse with redactInsteadOfThrow', () => {
  it('redacts a leaked secret in an uncompressed response', async () => {
    const resp = await fetch(`${baseUrl}/string-leak`);
    const body = await resp.text();
    expect(body).not.toContain(SECRET);
    expect(body).toContain('▒'); // redaction marker in place of the secret
  });

  it('passes a clean gzip response through intact', async () => {
    const resp = await fetch(`${baseUrl}/gzip-clean`);
    const body = await resp.text(); // fetch auto-decompresses
    expect(body).toBe(htmlClean);
  });

  it('fails closed on a leak in a gzip response (cannot scrub compressed chunks)', async () => {
    let failed = false;
    let body = '';
    try {
      const resp = await fetch(`${baseUrl}/gzip-leak`);
      body = await resp.text();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(body).not.toContain(SECRET);
  });
});
