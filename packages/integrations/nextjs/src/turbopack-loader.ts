/* eslint-disable no-console */

import type { SerializedEnvGraph } from 'varlock';

type LoaderContext = {
  cacheable(flag: boolean): void;
  resourcePath: string;
  rootContext: string;
};

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// matches: import { ... } from 'varlock/env'  (with various quote styles, spacing, and any named imports)
const VARLOCK_ENV_IMPORT_RE = /import\s*\{[^}]*\}\s*from\s*['"]varlock\/env['"]\s*;?/;

// detect 'use client' directive at top of file (before any code, after optional comments)
const USE_CLIENT_RE = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*\n)*\s*['"]use client['"]/;

// match directive prologue ('use server', 'use client', etc.) + optional trailing semicolons/newlines
// captures the directive block so we can inject code after it
const DIRECTIVE_PROLOGUE_RE = /^((?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*\n)*\s*['"]use (?:server|client|strict)['"]\s*;?\s*\n?)/;

/** Prepend code after any directive prologue (e.g. 'use server') to avoid breaking it */
function prependAfterDirectives(source: string, codeToPrepend: string): string {
  const match = source.match(DIRECTIVE_PROLOGUE_RE);
  if (match) {
    return match[1] + codeToPrepend + '\n' + source.slice(match[1].length);
  }
  return codeToPrepend + '\n' + source;
}

/**
 * Turbopack-compatible webpack loader that:
 * 1. In instrumentation.ts and proxy.ts: ensures varlock/env is imported, injects
 *    resolved env data, and calls initVarlockEnv(). The resolve alias maps varlock/env
 *    to a self-contained bundle that includes env runtime + all patches (console
 *    redaction, response scanning, leak prevention).
 * 2. Replaces `ENV.KEY` references for non-sensitive vars with literal JSON values.
 *
 * SECURITY: Sensitive env values are ONLY embedded into files that are guaranteed
 * server-only (instrumentation.ts, proxy.ts). The static ENV.KEY replacements
 * explicitly skip sensitive vars.
 */
function turbopackLoader(this: LoaderContext, source: string) {
  // disable caching so we always re-run when env values change
  this.cacheable(false);

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

  console.log(`[varlock-turbopack] processing: ${relPath}`);

  // skip client components — patches use node builtins (zlib, http) that don't work in browser
  const isClientComponent = USE_CLIENT_RE.test(source);
  if (isClientComponent) {
    console.log(`[varlock-turbopack] skipping client component: ${relPath}`);
    return source;
  }

  const rawEnv = process.env.__VARLOCK_ENV;
  if (!rawEnv) {
    console.log(`[varlock-turbopack] no __VARLOCK_ENV, skipping: ${relPath}`);
    return source;
  }

  let envGraph: SerializedEnvGraph;
  try {
    envGraph = JSON.parse(rawEnv);
  } catch {
    return source;
  }

  let result = source;

  const hasVarlockImport = VARLOCK_ENV_IMPORT_RE.test(result);
  const isProxyFile = /[/\\]proxy\.[jt]sx?$/.test(this.resourcePath);
  const isInstrumentationFile = /[/\\]instrumentation\.[jt]sx?$/.test(this.resourcePath);
  console.log(`[varlock-turbopack] ${relPath}: hasVarlockImport=${hasVarlockImport}, isProxyFile=${isProxyFile}, isInstrumentation=${isInstrumentationFile}`);

  // For proxy and instrumentation files: ensure varlock is initialized with env data.
  // The resolve alias maps varlock/env to a self-contained bundle that includes
  // the env runtime + all patches. Importing it triggers patches as a side effect.
  // We then inject the resolved env JSON + an explicit initVarlockEnv() call,
  // because ESM imports are hoisted (the module's auto-init runs before our env
  // data is set, so we need to re-init after setting it).
  if (isInstrumentationFile || isProxyFile) {
    if (hasVarlockImport) {
      // expand existing import to include initVarlockEnv if not already there
      if (!result.includes('initVarlockEnv')) {
        result = result.replace(
          VARLOCK_ENV_IMPORT_RE,
          (m) => m.replace(/\}/, ', initVarlockEnv }'),
        );
      }
    } else {
      // add import — the resolve alias ensures this loads the bundled module
      result = prependAfterDirectives(result, "import { initVarlockEnv } from 'varlock/env';");
    }

    // inject env data + init call right after the import
    const initCode = [
      `process.env.__VARLOCK_ENV = process.env.__VARLOCK_ENV || ${JSON.stringify(rawEnv)};`,
      'initVarlockEnv();',
    ].join('\n');
    result = result.replace(VARLOCK_ENV_IMPORT_RE, (m) => `${m}\n${initCode}`);
    console.log(`[varlock-turbopack] ✅ injected varlock init into ${relPath}`);
  }

  // static replacements for non-sensitive env vars
  if (source.includes('ENV.')) {
    for (const [key, item] of Object.entries(envGraph.config)) {
      if (item.isSensitive) continue;

      // match ENV.KEY as a member expression (word boundary before ENV, not followed by more identifier chars)
      const pattern = new RegExp(`\\bENV\\.${escapeRegExp(key)}(?![\\w$])`, 'g');
      result = result.replace(pattern, JSON.stringify(item.value));
    }
  }

  return result;
}

// CJS export required for webpack loader-runner compatibility
module.exports = turbopackLoader;
