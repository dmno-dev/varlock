import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

let prelude = '/* prelude */';
vi.mock('../src/freeze-into-bundle', () => ({ getRuntimePrelude: () => prelude }));

const RUNTIME_REL = '../chunks/ssr/[turbopack]_runtime.js';
const ORIGINAL_RUNTIME_HASH = '14457deed6fc841610caa86a32f782bf';
const OTHER_HASH = 'ef6ac6914a3f24c9f4a98105a3bdd310';

let nextDir: string;
beforeEach(() => {
  nextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-next-runtime-inject-'));
  fs.mkdirSync(path.join(nextDir, 'server', 'chunks', 'ssr'), { recursive: true });
  fs.mkdirSync(path.join(nextDir, 'server', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(nextDir, 'server', 'chunks', 'ssr', '[turbopack]_runtime.js'), '/* turbopack runtime */');
  fs.writeFileSync(path.join(nextDir, 'server', 'pages', 'other.js'), '/* other */');
});
afterEach(() => {
  fs.rmSync(nextDir, { recursive: true, force: true });
});

function writeTrace(name: string, trace: object) {
  const tracePath = path.join(nextDir, 'server', 'pages', `${name}.js.nft.json`);
  fs.writeFileSync(tracePath, JSON.stringify(trace));
  return tracePath;
}
const readTrace = (tracePath: string) => JSON.parse(fs.readFileSync(tracePath, 'utf8'));

async function injectFresh() {
  vi.resetModules();
  const { injectVarlockInitIntoTurbopackRuntime } = await import('../src/turbopack-runtime-inject');
  injectVarlockInitIntoTurbopackRuntime(nextDir);
}

describe('traced file hashes of the rewritten turbopack runtime', () => {
  it('replaces the stale hash of the runtime file and leaves other entries alone', async () => {
    const tracePath = writeTrace('page', {
      version: 1,
      files: [RUNTIME_REL, 'other.js'],
      fileHashes: [ORIGINAL_RUNTIME_HASH, OTHER_HASH],
    });

    await injectFresh();
    const trace = readTrace(tracePath);
    expect(trace.files).toEqual([RUNTIME_REL, 'other.js']);
    expect(trace.fileHashes[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.fileHashes[0]).not.toBe(ORIGINAL_RUNTIME_HASH);
    expect(trace.fileHashes[1]).toBe(OTHER_HASH);
  });

  // e.g. a redeploy where only an env value changed: Turbopack's original runtime file is
  // identical, so only the injected prelude tells the builds apart
  it('gives builds with different frozen envs different hashes', async () => {
    const trace = { version: 1, files: [RUNTIME_REL], fileHashes: [ORIGINAL_RUNTIME_HASH] };

    prelude = '/* frozen env A */';
    const tracePath = writeTrace('page', trace);
    await injectFresh();
    const hashA = readTrace(tracePath).fileHashes[0];

    fs.writeFileSync(path.join(nextDir, 'server', 'chunks', 'ssr', '[turbopack]_runtime.js'), '/* turbopack runtime */');
    prelude = '/* frozen env B */';
    writeTrace('page', trace);
    await injectFresh();
    expect(readTrace(tracePath).fileHashes[0]).not.toBe(hashA);
  });

  it('leaves traces without fileHashes (webpack) untouched', async () => {
    const original = JSON.stringify({ version: 1, files: [RUNTIME_REL] });
    const tracePath = path.join(nextDir, 'server', 'pages', 'page.js.nft.json');
    fs.writeFileSync(tracePath, original);

    await injectFresh();
    expect(fs.readFileSync(tracePath, 'utf8')).toBe(original);
  });
});
