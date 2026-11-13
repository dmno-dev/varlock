import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getRuntimePrelude } from './freeze-into-bundle';

function debug(...args: Array<any>) {
  if (!process.env.DEBUG_VARLOCK_NEXT_INTEGRATION) return;
  // eslint-disable-next-line no-console
  console.log('[varlock]', ...args);
}

// rewritten file -> hash of its new contents
const injectedFileHashes = new Map<string, string>();

/** Same width as Turbopack's own NFT hashes (128 bits, hex); consumers treat them as opaque */
function contentHash(source: string) {
  return createHash('sha256').update(source).digest('hex').slice(0, 32);
}

function updateNftFile(nftPath: string) {
  let nft: { files?: Array<string>, fileHashes?: Array<string | null> };
  try {
    nft = JSON.parse(fs.readFileSync(nftPath, 'utf8'));
  } catch {
    return;
  }
  const { files, fileHashes } = nft;
  if (!Array.isArray(files) || !Array.isArray(fileHashes)) return;
  let changed = false;
  files.forEach((file, i) => {
    const newHash = injectedFileHashes.get(path.resolve(path.dirname(nftPath), file));
    if (newHash && fileHashes[i] !== newHash) {
      fileHashes[i] = newHash;
      changed = true;
    }
  });
  if (changed) {
    fs.writeFileSync(nftPath, JSON.stringify(nft));
    debug(`updated traced file hashes in: ${nftPath}`);
  }
}

/**
 * Turbopack records a content hash for every traced file in its `.nft.json` traces
 * (`fileHashes`), and Next's adapter hands those to the deploy platform (Vercel writes them
 * into each function's `.vc-config.json`). They are written at emit, before we rewrite the
 * runtime files, so they describe the original file, which is identical across builds whose
 * frozen env differs. Point them at the rewritten contents so nothing keyed on them can treat
 * a new build's runtime file as an old one.
 */
function updateNftHashesForInjectedFiles(nextDirPath: string) {
  if (!injectedFileHashes.size) return;
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      // the build cache holds no traces and can be large
      if (entry.isDirectory()) {
        if (entryPath !== path.join(nextDirPath, 'cache')) walk(entryPath);
      } else if (entry.name.endsWith('.nft.json')) updateNftFile(entryPath);
    }
  };
  walk(nextDirPath);
}

/**
 * Inject varlock init bundle into turbopack runtime files (analogous to webpack runtime injection).
 * Turbopack writes `[turbopack]_runtime.js` files during compilation — these are loaded by
 * the deployed server before any user code runs, making them the ideal injection point.
 *
 * Note: pre-rendering workers during builds receive compiled code via IPC (not from disk),
 * so this injection only takes effect for the deployed server. Build-time init is handled
 * by the turbopack loader's init guard snippet.
 */
let injectedTurbopackRuntime = false;
export function injectVarlockInitIntoTurbopackRuntime(nextDirPath: string) {
  if (injectedTurbopackRuntime) return;

  // Find turbopack runtime files ([turbopack]_runtime.js) and edge-wrapper files.
  // Node.js SSR/build uses [turbopack]_runtime.js, while edge runtime uses
  // edge-wrapper JS files (no [turbopack]_runtime.js exists for edge).
  const serverRuntimeFiles: Array<string> = [];
  const edgeWrapperFiles: Array<string> = [];
  const walkDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name));
      } else if (entry.name === '[turbopack]_runtime.js') {
        serverRuntimeFiles.push(path.join(dir, entry.name));
      } else if (entry.name.includes('edge-wrapper') && entry.name.endsWith('.js')) {
        edgeWrapperFiles.push(path.join(dir, entry.name));
      }
    }
  };
  walkDir(nextDirPath);

  debug(`turbopack runtime injection: found ${serverRuntimeFiles.length} server runtime files, ${edgeWrapperFiles.length} edge wrapper files`);

  if (!serverRuntimeFiles.length) {
    // Runtime files may not exist yet — turbopack (Rust) writes them directly.
    // We'll retry on subsequent fs writes until they appear.
    return;
  }

  // Mark as done so we don't retry
  injectedTurbopackRuntime = true;

  // One init bundle serves server and edge runtimes: it loads node builtins lazily and the
  // patches that need them are no-ops where they are missing
  const initBundleSrc = fs.readFileSync(require.resolve('varlock/init-bundle'), 'utf8');
  // a frozen build bakes its frozen env in here; otherwise nothing is baked and the server
  // resolves at boot (see freeze-into-bundle)
  const prelude = getRuntimePrelude();

  // The CJS init bundles use `exports.X = ...` at the end, so we must provide
  // a dummy `exports` object when wrapping in an IIFE to avoid ReferenceError.
  const iifeWrap = (src: string) => `(function(exports,module){${src}})({},{exports:{}});`;

  // Inject into [turbopack]_runtime.js files (node.js SSR + build) and edge-wrapper files
  for (const targetFile of [...serverRuntimeFiles, ...edgeWrapperFiles]) {
    const origSource = fs.readFileSync(targetFile, 'utf8');
    const updatedSource = [
      prelude,
      iifeWrap(initBundleSrc),
      origSource,
    ].join('\n');
    fs.writeFileSync(targetFile, updatedSource);
    injectedFileHashes.set(path.resolve(targetFile), contentHash(updatedSource));
    debug(`injected init bundle into: ${targetFile}`);
  }
  updateNftHashesForInjectedFiles(nextDirPath);
}

export function isInjectedTurbopackRuntime() {
  return injectedTurbopackRuntime;
}
