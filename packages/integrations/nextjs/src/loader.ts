import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse, type ParserPlugin } from '@babel/parser';
import { createReplacerTransformFn } from '@env-spec/utils/ast-replacer';
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
  getOptions?(): LoaderOptions;
};

type LoaderOptions = {
  bundler?: 'webpack' | 'turbopack';
  isEdge?: boolean;
  dev?: boolean;
  /**
   * Set by the turbopack rule scoped to the `browser` condition (Next 15.5+). Any file
   * compiled for the browser is client code, whether or not it has a 'use client' directive
   * (e.g. instrumentation-client.ts, or plain modules imported from client components).
   */
  browser?: boolean;
};

function isTurbopackWorker() {
  return !!(
    process.env.TURBOPACK
    || process.env.TURBOPACK_DEV
    || process.env.TURBOPACK_BUILD
    || process.env.npm_config_turbopack
  );
}

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// detect 'use client' directive at top of file (before any code, after optional comments)
// uses [^\S\n]* (horizontal whitespace) instead of \s* to avoid exponential backtracking
const USE_CLIENT_RE = /^(?:[^\S\n]*\/\/[^\n]*\n|[^\S\n]*\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/[^\S\n]*\n|[^\S\n]*\n)*[^\S\n]*['"]use client['"]/;

// detect files compiled for the edge runtime — turbopack has a single global
// loader rule (no per-compiler split like webpack), so we sniff the source
const EDGE_RUNTIME_RE = /export\s+const\s+runtime\s*=\s*['"](?:edge|experimental-edge)['"]/;
const MIDDLEWARE_FILE_RE = /(?:^|[\\/])middleware\.(?:ts|js|mts|mjs)$/;
// instrumentation-client runs only in the browser but has no 'use client' directive. Detected by
// name as a fallback for turbopack versions without per-condition rules (the `browser` option)
const INSTRUMENTATION_CLIENT_FILE_RE = /(?:^|[\\/])instrumentation-client\.(?:ts|tsx|js|jsx|mts|mjs)$/;

function isInNodeModules(filePath: string) {
  return filePath.includes('/node_modules/') || filePath.includes('\\node_modules\\');
}

// Files in varlock's own packages must never be transformed (injecting the init guard into
// varlock/env itself would be circular). Installed normally they sit in node_modules, but a
// symlinked install (link:, workspace:) resolves to a real path outside of it.
let varlockPackageDirs: Array<string> | undefined;
function getVarlockPackageDirs() {
  if (!varlockPackageDirs) {
    const dirs = new Set<string>();
    const addDir = (dir: string) => {
      dirs.add(dir);
      try {
        dirs.add(fs.realpathSync(dir));
      } catch { /* ignore */ }
    };
    // this integration (the loader is built to dist/loader.cjs)
    addDir(path.resolve(__dirname, '..'));
    try {
      // walk up from a resolved varlock entry to its package root
      let dir = path.dirname(require.resolve('varlock/env'));
      while (!fs.existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) {
        dir = path.dirname(dir);
      }
      addDir(dir);
    } catch { /* varlock not resolvable, nothing to skip */ }
    varlockPackageDirs = [...dirs].map((dir) => dir + path.sep);
  }
  return varlockPackageDirs;
}

/**
 * Whether the loader should transform a file. Anything outside node_modules is transformed,
 * including monorepo workspace packages outside the app dir (turbopack resolves symlinked
 * workspace packages to their real paths), except for varlock's own packages.
 */
function shouldTransformFile(filePath: string) {
  if (isInNodeModules(filePath)) return false;
  return !getVarlockPackageDirs().some((dir) => filePath.startsWith(dir));
}

// match the directive prologue ('use server', 'use client', 'use cache: remote', etc.)
// captures the whole block - including interleaved comments/blank lines and repeated
// directives - so injected code lands after all of them. a directive that is not the
// last thing in the prologue stops being a directive, so we must not inject between them.
// any 'use ...' string is matched rather than an allowlist, so new framework directives
// keep working. requiring end-of-line after the directive keeps us from matching a string
// that continues into a larger expression (`'use x' + y`).
// uses [^\S\n]* (horizontal whitespace) instead of \s* to avoid exponential backtracking
const COMMENT_OR_BLANK_LINE_RE_STR = String.raw`[^\S\n]*\/\/[^\n]*\n|[^\S\n]*\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/[^\S\n]*\n|[^\S\n]*\n`;
const DIRECTIVE_RE_STR = String.raw`[^\S\n]*['"]use [^'"\n]*['"][^\S\n]*;?[^\S\n]*(?:\n|$)`;
const DIRECTIVE_PROLOGUE_RE = new RegExp(
  String.raw`^((?:${COMMENT_OR_BLANK_LINE_RE_STR})*(?:(?:${DIRECTIVE_RE_STR})(?:${COMMENT_OR_BLANK_LINE_RE_STR})*)+)`,
);

// rough check for ES module syntax (a line starting with import/export) — used to decide
// whether the injected init guard can use import statements instead of require()
const ESM_SYNTAX_RE = /^[^\S\n]*(?:import|export)\b/m;

// the loader runs for every project file, so cache the env graph parse
// (keyed on the raw string — env reloads produce a new string)
let cachedRawEnv: string | undefined;
let cachedEnvGraph: SerializedEnvGraph | undefined;
function parseEnvGraphCached(rawEnv: string): SerializedEnvGraph | undefined {
  if (rawEnv !== cachedRawEnv) {
    cachedRawEnv = rawEnv;
    try {
      cachedEnvGraph = JSON.parse(rawEnv);
    } catch {
      cachedEnvGraph = undefined;
    }
  }
  return cachedEnvGraph;
}

// replacer is derived from the env graph, so cache it alongside (keyed on graph identity)
let cachedReplacerGraph: SerializedEnvGraph | undefined;
let cachedReplacerTransform: ReturnType<typeof createReplacerTransformFn> | undefined;
function getReplacerTransformCached(envGraph: SerializedEnvGraph) {
  if (envGraph !== cachedReplacerGraph) {
    cachedReplacerGraph = envGraph;
    const replacements: Record<string, string> = {};
    for (const [key, item] of Object.entries(envGraph.config)) {
      if (item.isDynamic ?? item.isSensitive) continue;
      // 'undefined' as a string so it gets spliced in as a literal
      replacements[`ENV.${key}`] = item.value === undefined ? 'undefined' : JSON.stringify(item.value);
    }
    cachedReplacerTransform = createReplacerTransformFn({ replacements });
  }
  return cachedReplacerTransform!;
}

/** babel parse ctx with plugins appropriate for the file extension */
function makeBabelParseCtx(filePath: string) {
  const fileExt = filePath.split('?')[0].split('#')[0].split('.').pop() || '';
  const plugins: Array<ParserPlugin> = ['decorators-legacy', 'importAttributes'];
  if (fileExt === 'ts' || fileExt === 'mts' || fileExt === 'cts') {
    plugins.push('typescript');
  } else if (fileExt === 'tsx') {
    plugins.push('typescript', 'jsx');
  } else {
    plugins.push('jsx');
  }
  return {
    parse: (code: string) => babelParse(code, {
      sourceType: 'unambiguous',
      plugins,
      // still produce an AST when possible for code with recoverable errors
      errorRecovery: true,
    }),
  };
}

const parseFailureWarnedFiles = new Set<string>();

/**
 * Replace `ENV.KEY` member expressions with literal values via AST matching
 * (shared with the vite integration) so references inside string literals,
 * comments, and template literal text are never touched.
 * Falls back to regex replacement if the file fails to parse.
 */
/** keys that are public AND dynamic - the ones browsers hydrate at runtime */
function getPublicDynamicKeys(envGraph: SerializedEnvGraph): Array<string> {
  return Object.entries(envGraph.config)
    .filter(([, item]) => (item.isDynamic ?? item.isSensitive) && !item.isSensitive)
    .map(([key]) => key);
}

function inlineEnvValues(source: string, filePath: string, envGraph: SerializedEnvGraph): string {
  const replacerTransform = getReplacerTransformCached(envGraph);
  try {
    const magicString = replacerTransform(makeBabelParseCtx(filePath), source, filePath);
    return magicString ? magicString.toString() : source;
  } catch (err) {
    if (!parseFailureWarnedFiles.has(filePath)) {
      parseFailureWarnedFiles.add(filePath);
      // eslint-disable-next-line no-console
      console.warn(
        `[varlock] failed to parse ${filePath} for ENV replacement — falling back to regex replacement`,
        err instanceof Error ? `(${err.message})` : '',
      );
    }
    let result = source;
    for (const [key, item] of Object.entries(envGraph.config)) {
      if (item.isDynamic ?? item.isSensitive) continue;
      // match ENV.KEY as a member expression (word boundary before ENV, not followed by more identifier chars)
      const pattern = new RegExp(`\\bENV\\.${escapeRegExp(key)}(?![\\w$])`, 'g');
      result = result.replace(pattern, item.value === undefined ? 'undefined' : JSON.stringify(item.value));
    }
    return result;
  }
}

/** Prepend code after any directive prologue (e.g. 'use server') to avoid breaking it */
function prependAfterDirectives(source: string, codeToPrepend: string): string {
  const match = source.match(DIRECTIVE_PROLOGUE_RE);
  if (match) {
    // the last directive may end at EOF with no trailing newline, in which case the
    // injected code would be glued onto it (`'use server'if(...)`)
    const separator = match[1].endsWith('\n') ? '' : '\n';
    return `${match[1] + separator + codeToPrepend}\n${source.slice(match[1].length)}`;
  }
  return `${codeToPrepend}\n${source}`;
}

/**
 * Webpack/Turbopack loader that:
 * 1. Injects resolved env config into instrumentation and proxy files.
 * 2. Replaces `ENV.KEY` references for static vars with literal JSON values.
 *
 * SECURITY: Dynamic env values are not embedded at build time, and sensitive
 * values are expected to stay dynamic by default. The static ENV.KEY
 * replacements explicitly skip dynamic vars.
 */
function webpackLoader(this: LoaderContext, source: string) {
  if (!shouldTransformFile(this.resourcePath)) return source;

  const projectRoot = this.rootContext || process.cwd();
  const relPath = path.relative(projectRoot, this.resourcePath);
  // files outside the project root (monorepo workspace packages) get ENV inlining only. The
  // init guard's require()s resolve from the file's own location, where the app's deps
  // (e.g. @varlock/nextjs-integration) usually aren't installed. The guard only needs to run
  // once per process, which the app's own files already take care of.
  const isInProjectRoot = !relPath.startsWith('..') && !path.isAbsolute(relPath);
  debug('processing:', relPath);

  const loaderOptions = this.getOptions?.() ?? {};

  // client code = compiled for the browser, or a 'use client' component (which is also
  // compiled for SSR, but must still be treated as client code there)
  const isClientComponent = loaderOptions.browser
    || USE_CLIENT_RE.test(source)
    || INSTRUMENTATION_CLIENT_FILE_RE.test(this.resourcePath);
  if (isClientComponent) debug('client code:', relPath);

  const rawEnv = process.env.__VARLOCK_ENV;
  if (!rawEnv) {
    throw new Error('expected __VARLOCK_ENV to be set');
  }

  const envGraph = parseEnvGraphCached(rawEnv);
  if (!envGraph) return source;

  const isWebpack = loaderOptions.bundler === 'webpack';
  const isTurbopack = loaderOptions.bundler === 'turbopack' || isTurbopackWorker();
  const isEdge = loaderOptions.isEdge ?? false;
  // webpack signals edge via a per-compilation loader option; turbopack has a
  // single global rule, so edge files are detected by sniffing the source /
  // file path (middleware and `export const runtime = 'edge'` routes)
  const isEdgeFile = isEdge
    || EDGE_RUNTIME_RE.test(source)
    || MIDDLEWARE_FILE_RE.test(this.resourcePath);

  let result = source;

  if (!isClientComponent && isInProjectRoot) {
    // Inject a tiny guarded init snippet into every server file.
    // Pre-rendering workers receive compiled code via IPC (not from disk), so runtime
    // file injection doesn't help them. This ensures initVarlockEnv() and
    // patchGlobalConsole() run once per process — the globalThis guard makes it
    // idempotent, and turbopack deduplicates the require() targets.
    let initGuard: string;
    if (isEdgeFile) {
      // Edge context: no direct initVarlockEnv() call — env init is owned by the
      // injected init-edge bundle, which may decrypt an encrypted env blob
      // ASYNCHRONOUSLY (runtimes without node:crypto, e.g. Vercel Edge). A direct
      // init here would race that decrypt and JSON.parse the still-encrypted blob.
      // We only re-patch console via globalThis.__varlockPatchConsole (exposed by
      // init-edge); in dev (no runtime injection) the bundled env module
      // self-initializes from the sandbox's process.env instead.
      initGuard = 'if(globalThis.__varlockPatchConsole)globalThis.__varlockPatchConsole();';
      result = prependAfterDirectives(result, initGuard);
    } else if (isWebpack && ESM_SYNTAX_RE.test(source)) {
      // Webpack compiles pages-router files in the "pages layer", which keeps
      // node_modules external — and since varlock is ESM-only, an injected
      // require() of it is a webpack build error (import-esm-externals).
      // For ES modules we inject import statements instead: imports hoist, so
      // evaluation order is the same as the require() version (user imports
      // still evaluate first, guard runs before any module statements).
      initGuard = [
        'import {initVarlockEnv as __varlock$init} from \'varlock/env\';',
        'import {patchGlobalConsole as __varlock$patchConsole} from \'varlock/patch-console\';',
        'import {initVarlockNextDynamicAccess as __varlock$initDynAccess} from \'@varlock/nextjs-integration/dynamic-access\';',
        'if(!globalThis.__varlockBuildInit){globalThis.__varlockBuildInit=true;__varlock$init();__varlock$patchConsole();__varlock$initDynAccess();}',
        // React wraps console for RSC dev replay AFTER our initial patch in the
        // runtime file. Re-patching outside the once-guard ensures our redaction
        // wraps React's wrapper so secrets are redacted before React captures them.
        // patchGlobalConsole() no-ops if console.log still has _varlockPatchedFn.
        '__varlock$patchConsole();',
      ].join('');
      result = prependAfterDirectives(result, initGuard);
    } else {
      initGuard = 'if(!globalThis.__varlockBuildInit){globalThis.__varlockBuildInit=true;require(\'varlock/env\').initVarlockEnv();require(\'varlock/patch-console\').patchGlobalConsole();require(\'@varlock/nextjs-integration/dynamic-access\').initVarlockNextDynamicAccess();}';
      // (see comment above about re-patching console for webpack RSC dev replay)
      if (isWebpack) {
        initGuard += 'require(\'varlock/patch-console\').patchGlobalConsole();';
      }
      result = prependAfterDirectives(result, initGuard);
    }
  } else if (isClientComponent) {
    // Client components: inject the declared public+dynamic key list so the runtime
    // hydration helpers (loadPublicDynamicEnv, setPublicDynamicEnv payload filtering,
    // hydration-state checks) work in the browser. Key NAMES only - never values.
    // `??=` so a fresher runtime-computed list (server-side initVarlockEnv, or a dev
    // reload) is never clobbered by the build-time snapshot. This is the injection
    // path for turbopack (whose loader runs for browser-context files); webpack client
    // compilations have no loader, so the webpack plugin injects the same snippet
    // into the client runtime chunk instead.
    const publicDynamicKeys = getPublicDynamicKeys(envGraph);
    if (publicDynamicKeys.length) {
      result = prependAfterDirectives(
        result,
        `globalThis.__varlockPublicDynamicKeys ??= ${JSON.stringify(publicDynamicKeys)};`,
      );
    }
  }

  // NOTE - dynamic ENV access marking routes dynamic is handled at runtime by the
  // global access hook (see dynamic-access.ts, installed via the init guard above).
  // A source-level rewrite that imported next/headers was tried and reverted: the
  // injected import is a hard compile error in pages-router files.

  // static replacements for non-dynamic env vars
  // webpack uses DefinePlugin for this, so only needed for turbopack
  if (isTurbopack && source.includes('ENV.')) {
    const isDev = loaderOptions.dev ?? process.env.NODE_ENV === 'development';

    // In dev, server-side (node runtime) files read env through the runtime
    // proxy instead, which stays fresh when env files change and reload —
    // inlined values can't be refreshed without a recompile, which turbopack
    // won't do for env-only changes. Inlining is still required for client
    // components (the browser can't read server env) and edge files (env is
    // injected at sandbox init), and for all files during builds.
    const inlineStaticValues = !isDev || isClientComponent || isEdgeFile;

    if (inlineStaticValues) {
      // disable caching only for files that embed ENV values — their output depends on env values
      this.cacheable(false);
      result = inlineEnvValues(result, this.resourcePath, envGraph);
    }
  }

  return result;
}

// CJS export required for webpack loader-runner compatibility
module.exports = webpackLoader;
