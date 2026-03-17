import type { SerializedEnvGraph } from 'varlock';

function debug(...args: Array<any>) {
  if (!process.env.DEBUG_VARLOCK_NEXT_INTEGRATION) return;
  // eslint-disable-next-line no-console
  console.log('[varlock-loader]', ...args);
}

type LoaderContext = {
  cacheable(flag: boolean): void;
  resourcePath: string;
  rootContext: string;
  getOptions?(): { bundler?: 'webpack' | 'turbopack'; isEdge?: boolean };
};

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// detect 'use client' directive at top of file (before any code, after optional comments)
// uses [^\S\n]* (horizontal whitespace) instead of \s* to avoid exponential backtracking
const USE_CLIENT_RE = /^(?:[^\S\n]*\/\/[^\n]*\n|[^\S\n]*\/\*[\s\S]*?\*\/[^\S\n]*\n|[^\S\n]*\n)*[^\S\n]*['"]use client['"]/;

// match directive prologue ('use server', 'use client', etc.) + optional trailing semicolons/newlines
// captures the directive block so we can inject code after it
const DIRECTIVE_PROLOGUE_RE = /^((?:[^\S\n]*\/\/[^\n]*\n|[^\S\n]*\/\*[\s\S]*?\*\/[^\S\n]*\n|[^\S\n]*\n)*[^\S\n]*['"]use (?:server|client|strict)['"][^\S\n]*;?[^\S\n]*\n?)/;

/** Prepend code after any directive prologue (e.g. 'use server') to avoid breaking it */
function prependAfterDirectives(source: string, codeToPrepend: string): string {
  const match = source.match(DIRECTIVE_PROLOGUE_RE);
  if (match) {
    return `${match[1] + codeToPrepend}\n${source.slice(match[1].length)}`;
  }
  return `${codeToPrepend}\n${source}`;
}

/**
 * Webpack/Turbopack loader that:
 * 1. Injects resolved env config into instrumentation and proxy files.
 * 2. Replaces `ENV.KEY` references for non-sensitive vars with literal JSON values.
 *
 * SECURITY: Sensitive env values are ONLY embedded into server-side files
 * (never client components). The static ENV.KEY replacements explicitly skip
 * sensitive vars.
 */
function webpackLoader(this: LoaderContext, source: string) {
  // disable caching so we always re-run when env values change
  this.cacheable(false); // TODO: probably dont want this?

  // only transform files within the project root
  // this skips node_modules AND symlinked workspace packages (e.g. varlock/env)
  // which turbopack resolves to their real paths outside node_modules
  const projectRoot = this.rootContext || process.cwd();
  if (!this.resourcePath.startsWith(projectRoot)) {
    return source;
  }
  // still skip node_modules within the project root
  const relPath = this.resourcePath.slice(projectRoot.length);
  if (relPath.includes('/node_modules/') || relPath.includes('\\node_modules\\')) {
    return source;
  }

  debug('processing:', relPath);

  // skip client components — patches use node builtins (zlib, http) that don't work in browser
  const isClientComponent = USE_CLIENT_RE.test(source);
  if (isClientComponent) {
    debug('skipping client component:', relPath);
    return source;
  }

  const rawEnv = process.env.__VARLOCK_ENV;
  if (!rawEnv) {
    throw new Error('expected __VARLOCK_ENV to be set');
  }

  // TODO: avoid parsing on every file
  let envGraph: SerializedEnvGraph;
  try {
    envGraph = JSON.parse(rawEnv);
  } catch {
    return source;
  }

  let result = source;

  // Inject a tiny guarded init snippet into every server file.
  // Pre-rendering workers receive compiled code via IPC (not from disk), so runtime
  // file injection doesn't help them. This ensures initVarlockEnv() and
  // patchGlobalConsole() run once per process — the globalThis guard makes it
  // idempotent, and turbopack deduplicates the require() targets.
  const loaderOptions = this.getOptions?.() ?? {};

  const isWebpack = loaderOptions.bundler === 'webpack';
  const isTurbopack = loaderOptions.bundler === 'turbopack';
  const isEdge = loaderOptions.isEdge ?? false;

  let initGuard: string;
  if (isEdge) {
    // Edge compilation: can't use require(), so use globalThis.__varlockPatchConsole
    // which the init-edge bundle exposes. The init guard is skipped since edge init
    // is handled by the runtime file injection (processAssets hook).
    initGuard = 'if(globalThis.__varlockPatchConsole)globalThis.__varlockPatchConsole();';
  } else {
    initGuard = 'if(!globalThis.__varlockBuildInit){globalThis.__varlockBuildInit=true;require(\'varlock/env\').initVarlockEnv();require(\'varlock/patch-console\').patchGlobalConsole();}';
    // When used from webpack, React wraps console for RSC dev replay AFTER our initial
    // patch in the runtime file. Re-patching outside the once-guard ensures our redaction
    // wraps React's wrapper so secrets are redacted before React captures them.
    // patchGlobalConsole() no-ops if console.log still has _varlockPatchedFn.
    if (isWebpack) {
      initGuard += 'require(\'varlock/patch-console\').patchGlobalConsole();';
    }
  }
  result = prependAfterDirectives(result, initGuard);

  // static replacements for non-sensitive env vars
  // webpack uses DefinePlugin for this, so only needed for turbopack
  if (isTurbopack && source.includes('ENV.')) {
    for (const [key, item] of Object.entries(envGraph.config)) {
      if (item.isSensitive) continue;

      // TODO: smarter replacement (vite version uses AST?)

      // match ENV.KEY as a member expression (word boundary before ENV, not followed by more identifier chars)
      const pattern = new RegExp(`\\bENV\\.${escapeRegExp(key)}(?![\\w$])`, 'g');
      result = result.replace(pattern, JSON.stringify(item.value));
    }
  }

  return result;
}

// CJS export required for webpack loader-runner compatibility
module.exports = webpackLoader;
