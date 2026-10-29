/*
  Proves the runtime init entries can be evaluated where node builtins do not exist.

  The built ESM output (dist/) is loaded into a bare `node:vm` module context: no `require`,
  no `process.getBuiltinModule`, and a linker that rejects every non-relative specifier. That
  catches two things at once - a static `import 'node:...'` sneaking into the module graph of
  an entry that edge runtimes evaluate, and module-scope code that reaches for a builtin.
  Runs the real dist files (not src) because that is what ships.

  Needs the package built first (`bunx turbo run build --filter=varlock`); test:ci does this.
*/
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encryptEnvBlobSync } from '../crypto';

const DIST_RUNTIME_DIR = path.resolve(import.meta.dirname, '../../../dist/runtime');

const FAKE_GRAPH = {
  sources: [],
  settings: {},
  config: {
    SECRET_KEY: { value: 'super-secret-value-abc123', isSensitive: true },
    PUBLIC_KEY: { value: 'public-value', isSensitive: false },
  },
};

/**
 * Evaluates a dist ESM entry inside a vm context with no node builtins, then runs `probe`
 * (source of an async function body receiving `{ ns, sandbox }`) inside the child process
 * and returns its JSON result. A child process is needed because vm.SourceTextModule is
 * behind --experimental-vm-modules.
 */
function evaluateInEdgeLikeContext(entryFile: string, opts: {
  env?: Record<string, string>,
  /** extra globals present before the entry evaluates (what earlier code in a bundle would set) */
  globals?: Record<string, unknown>,
  probe: string,
}) {
  const entryPath = path.join(DIST_RUNTIME_DIR, entryFile);
  if (!existsSync(entryPath)) {
    throw new Error(`${entryPath} is missing - build varlock first (bunx turbo run build --filter=varlock)`);
  }
  const script = `
    import vm from 'node:vm';
    import fs from 'node:fs';
    import path from 'node:path';

    const entryPath = ${JSON.stringify(entryPath)};
    // what an edge runtime provides: web globals, a process shim with env, and nothing
    // node-specific (no getBuiltinModule, no require)
    const sandbox = {
      console, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask,
      URL, Response, Request, Headers, ReadableStream, crypto, atob, btoa,
      process: { env: ${JSON.stringify(opts.env ?? {})} },
      ...${JSON.stringify(opts.globals ?? {})},
    };
    const context = vm.createContext(sandbox);
    const cache = new Map();
    function load(file) {
      if (cache.has(file)) return cache.get(file);
      const mod = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), {
        context,
        identifier: file,
        initializeImportMeta: (meta) => { meta.url = 'file://' + file; },
      });
      cache.set(file, mod);
      return mod;
    }
    async function link(specifier, referencing) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw new Error('static import of a non-relative module in the edge init graph: ' + specifier + ' (from ' + referencing.identifier + ')');
      }
      return load(path.resolve(path.dirname(referencing.identifier), specifier));
    }
    const entry = load(entryPath);
    await entry.link(link);
    await entry.evaluate();
    const probe = async ({ ns, sandbox }) => { ${opts.probe} };
    process.stdout.write('__RESULT__' + JSON.stringify(await probe({ ns: entry.namespace, sandbox })));
  `;
  const stdout = execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const marker = stdout.lastIndexOf('__RESULT__');
  if (marker === -1) throw new Error(`probe produced no result:\n${stdout}`);
  return JSON.parse(stdout.slice(marker + '__RESULT__'.length));
}

/**
 * Evaluates the self-contained CJS init bundle the Next.js integration injects into server
 * and edge runtime files, inside a vm context shaped like Vercel's edge-light sandbox: a process shim
 * without getBuiltinModule, and a `require` that only knows a handful of builtins (not
 * crypto, http or zlib) and throws for everything else.
 */
function evaluateCjsBundleInEdgeLikeContext(bundleFile: string, opts: {
  env?: Record<string, string>,
  /** model Next's dev edge sandbox, whose `process` shim throws when a node API is read off it */
  processThrowsOnNodeApis?: boolean,
  probe: string,
}) {
  const bundlePath = path.join(DIST_RUNTIME_DIR, bundleFile);
  if (!existsSync(bundlePath)) {
    throw new Error(`${bundlePath} is missing - build varlock first (bunx turbo run build --filter=varlock)`);
  }
  const script = `
    import vm from 'node:vm';
    import fs from 'node:fs';
    import { createRequire } from 'node:module';

    const nodeRequire = createRequire(import.meta.url);
    const EDGE_ALLOWED_BUILTINS = ['async_hooks', 'events', 'buffer', 'util', 'assert'];
    function edgeRequire(mod) {
      const bare = mod.replace(/^node:/, '');
      if (EDGE_ALLOWED_BUILTINS.includes(bare)) return nodeRequire('node:' + bare);
      throw new Error('Native module not found: ' + bare);
    }
    const module = { exports: {} };
    const processShim = { env: ${JSON.stringify(opts.env ?? {})} };
    if (${JSON.stringify(!!opts.processThrowsOnNodeApis)}) {
      for (const api of ['getBuiltinModule', 'stdout', 'stderr', 'ppid', 'cwd']) {
        Object.defineProperty(processShim, api, {
          get() { throw new Error('A Node.js API is used (process.' + api + ') which is not supported in the Edge Runtime.'); },
        });
      }
    }
    const sandbox = {
      console, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask,
      URL, Response, Request, Headers, ReadableStream, crypto, atob, btoa,
      process: processShim,
      require: edgeRequire, module, exports: module.exports,
    };
    const context = vm.createContext(sandbox);
    new vm.Script(fs.readFileSync(${JSON.stringify(bundlePath)}, 'utf8'), { filename: ${JSON.stringify(bundlePath)} }).runInContext(context);
    const probe = async ({ ns, sandbox }) => { ${opts.probe} };
    process.stdout.write('__RESULT__' + JSON.stringify(await probe({ ns: module.exports, sandbox })));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const marker = stdout.lastIndexOf('__RESULT__');
  if (marker === -1) throw new Error(`probe produced no result:\n${stdout}`);
  return JSON.parse(stdout.slice(marker + '__RESULT__'.length));
}

describe('runtime entries evaluate without node builtins', () => {
  it('patch-server-response loads, and patching is a no-op without node:http', () => {
    const result = evaluateInEdgeLikeContext('patch-server-response.mjs', {
      probe: `
        ns.patchGlobalServerResponse();
        return { exported: typeof ns.patchGlobalServerResponse };
      `,
    });
    expect(result).toEqual({ exported: 'function' });
  });

  it('varlock/auto-init runs the full sequence from an injected env blob', () => {
    const result = evaluateInEdgeLikeContext('auto-init.mjs', {
      env: { __VARLOCK_ENV: JSON.stringify(FAKE_GRAPH) },
      probe: `
        return {
          publicValue: ns.ENV.PUBLIC_KEY,
          secretValue: ns.ENV.SECRET_KEY,
          consolePatched: !!sandbox.console.log._varlockPatchedFn,
          patchConsoleExposed: typeof sandbox.__varlockPatchConsole,
          redacted: ns.redactSensitiveConfig('x ' + ns.ENV.SECRET_KEY + ' y'),
        };
      `,
    });
    expect(result).toEqual({
      publicValue: 'public-value',
      secretValue: 'super-secret-value-abc123',
      consolePatched: true,
      patchConsoleExposed: 'function',
      redacted: expect.not.stringContaining('super-secret-value-abc123'),
    });
  });

  it('an already-resolved env wins over an encrypted process.env blob (no decrypt, no key needed)', () => {
    // the Cloudflare init entry sets __varlockLoadedEnv itself, while workerd can also expose
    // the same (still encrypted) binding on process.env without the key being readable there
    const result = evaluateInEdgeLikeContext('auto-init.mjs', {
      env: { __VARLOCK_ENV: encryptEnvBlobSync(JSON.stringify(FAKE_GRAPH), 'ef'.repeat(32)) },
      globals: { __varlockLoadedEnv: { ...FAKE_GRAPH, config: { ...FAKE_GRAPH.config, PUBLIC_KEY: { value: 'from-loaded-env', isSensitive: false } } } },
      probe: 'return { publicValue: ns.ENV.PUBLIC_KEY };',
    });
    expect(result).toEqual({ publicValue: 'from-loaded-env' });
  });

  it('varlock/auto-init decrypts an encrypted blob asynchronously when node:crypto is missing', () => {
    // encrypt in this (node) process, decrypt inside the context via Web Crypto fallback
    const key = 'ab'.repeat(32);
    const result = evaluateInEdgeLikeContext('auto-init.mjs', {
      env: { __VARLOCK_ENV: encryptEnvBlobSync(JSON.stringify(FAKE_GRAPH), key), _VARLOCK_ENV_KEY: key },
      probe: `
        const readyIsPromise = typeof sandbox.__varlockEnvReady?.then === 'function';
        await sandbox.__varlockEnvReady;
        return { readyIsPromise, publicValue: ns.ENV.PUBLIC_KEY };
      `,
    });
    expect(result).toEqual({ readyIsPromise: true, publicValue: 'public-value' });
  });

  it('the injected init-bundle CJS file runs in an edge-light sandbox with a limited require()', () => {
    const key = 'cd'.repeat(32);
    const result = evaluateCjsBundleInEdgeLikeContext('init-bundle.cjs', {
      env: { __VARLOCK_ENV: encryptEnvBlobSync(JSON.stringify(FAKE_GRAPH), key), _VARLOCK_ENV_KEY: key },
      probe: `
        // no node:crypto behind this require(), so init falls back to async Web Crypto
        await sandbox.__varlockEnvReady;
        return {
          publicValue: ns.ENV.PUBLIC_KEY,
          consolePatched: !!sandbox.console.log._varlockPatchedFn,
          patchConsoleExposed: typeof sandbox.__varlockPatchConsole,
        };
      `,
    });
    expect(result).toEqual({ publicValue: 'public-value', consolePatched: true, patchConsoleExposed: 'function' });
  });

  it("the injected init-bundle runs under Next's dev edge sandbox, whose process shim throws on node APIs", () => {
    // the old edge bundle never touched node builtins; the unified one must survive a
    // `process` whose node-API properties throw on access rather than being undefined
    const result = evaluateCjsBundleInEdgeLikeContext('init-bundle.cjs', {
      env: { __VARLOCK_ENV: JSON.stringify(FAKE_GRAPH) },
      processThrowsOnNodeApis: true,
      probe: `
        return {
          publicValue: ns.ENV.PUBLIC_KEY,
          consolePatched: !!sandbox.console.log._varlockPatchedFn,
          patchConsoleExposed: typeof sandbox.__varlockPatchConsole,
        };
      `,
    });
    expect(result).toEqual({ publicValue: 'public-value', consolePatched: true, patchConsoleExposed: 'function' });
  });
});
