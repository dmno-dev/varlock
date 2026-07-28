import fs from 'node:fs';
import path from 'node:path';
import { encryptEnvBlobSync } from 'varlock/encrypt-env';

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

  const rawEnv = process.env.__VARLOCK_ENV;
  if (!rawEnv) {
    return;
  }

  const encryptionKey = process.env._VARLOCK_ENV_KEY;
  let encryptionRequired = false;
  try {
    const parsed = JSON.parse(rawEnv);
    encryptionRequired = !!parsed?.settings?.encryptInjectedEnv;
  } catch { /* ignore parse errors */ }
  if (encryptionRequired && !encryptionKey) {
    throw new Error(
      '[varlock] @encryptInjectedEnv is enabled but _VARLOCK_ENV_KEY is not set.\n'
      + 'Generate a key with `varlock generate-key` and set it on your platform.\n'
      + 'See https://varlock.dev/guides/encrypted-deployments/ for details.',
    );
  }
  let envPayload = rawEnv;
  if (encryptionKey) {
    envPayload = encryptEnvBlobSync(rawEnv, encryptionKey);
  }

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

  // Vercel has no native runtime-binding mechanism, so baking the resolved env
  // into the build is the correct approach there — but plaintext means secrets
  // sit as JSON in the build artifact. Nudge (don't block) users who haven't
  // opted into `@encryptInjectedEnv`. Placed after the guard above so it only
  // fires once (this function is called repeatedly until the runtime files
  // are found, per the early return above).
  if (process.env.VERCEL === '1' && !encryptionRequired) {
    // eslint-disable-next-line no-console
    console.warn(
      '[varlock] ⚠️ Deploying to Vercel ships your resolved env as plaintext JSON in the build artifact. '
      + 'Consider enabling `@encryptInjectedEnv` — see https://varlock.dev/guides/encrypted-deployments/',
    );
  }

  // Load both init bundles — server (full, node:zlib/node:http) and edge (no node builtins)
  const initServerSrc = fs.readFileSync(require.resolve('varlock/init-server'), 'utf8');
  const initEdgeSrc = fs.readFileSync(require.resolve('varlock/init-edge'), 'utf8');
  const envInline = `process.env.__VARLOCK_ENV = process.env.__VARLOCK_ENV || ${JSON.stringify(envPayload)};`;

  // The CJS init bundles use `exports.X = ...` at the end, so we must provide
  // a dummy `exports` object when wrapping in an IIFE to avoid ReferenceError.
  const iifeWrap = (src: string) => `(function(exports,module){${src}})({},{exports:{}});`;

  // Inject init-server into [turbopack]_runtime.js files (node.js SSR + build)
  for (const runtimeFile of serverRuntimeFiles) {
    const origSource = fs.readFileSync(runtimeFile, 'utf8');
    const updatedSource = [
      envInline,
      iifeWrap(initServerSrc),
      origSource,
    ].join('\n');
    fs.writeFileSync(runtimeFile, updatedSource);
    debug(`injected init-server into turbopack runtime: ${runtimeFile}`);
  }

  // Inject init-edge into edge-wrapper files (edge runtime — no node builtins)
  for (const wrapperFile of edgeWrapperFiles) {
    const origSource = fs.readFileSync(wrapperFile, 'utf8');
    const updatedSource = [
      envInline,
      iifeWrap(initEdgeSrc),
      origSource,
    ].join('\n');
    fs.writeFileSync(wrapperFile, updatedSource);
    debug(`injected init-edge into edge wrapper: ${wrapperFile}`);
  }
}

export function isInjectedTurbopackRuntime() {
  return injectedTurbopackRuntime;
}
