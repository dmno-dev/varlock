import fs from 'node:fs';
import path from 'node:path';
import { getRuntimePrelude } from './freeze-into-bundle';

function debug(...args: Array<any>) {
  if (!process.env.DEBUG_VARLOCK_NEXT_INTEGRATION) return;
  // eslint-disable-next-line no-console
  console.log('[varlock]', ...args);
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
    debug(`injected init bundle into: ${targetFile}`);
  }
}

export function isInjectedTurbopackRuntime() {
  return injectedTurbopackRuntime;
}
