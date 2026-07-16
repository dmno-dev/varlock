/**
 * JS runtime + OS detection, independent of CI/deploy platform detection.
 * Reads ambient globals (globalThis, process) rather than an env record, since these
 * signals (Deno global, process.versions.bun, navigator.userAgent, ...) aren't env vars.
 */

export type JsRuntime = | 'node'
  | 'deno'
  | 'bun'
  | 'workerd'
  | 'fastly'
  | 'netlify'
  | 'edge-light'
  | 'browser'
  | undefined;

export interface RuntimeInfo {
  runtime: JsRuntime;
  isNode: boolean;
  isDeno: boolean;
  isBun: boolean;
  /** Cloudflare Workers */
  isWorkerd: boolean;
  isFastly: boolean;
  isNetlify: boolean;
  /** Generic "edge" runtime (Vercel Edge Functions, Netlify Edge Functions, ...) */
  isEdgeLight: boolean;
  isBrowser: boolean;
}

/**
 * Detects the current JS runtime. Pass a custom `globalObj` (defaults to `globalThis`) for testing.
 */
export function detectRuntime(globalObj: any = globalThis): RuntimeInfo {
  const g = globalObj;
  const process = g.process;

  const isDeno = typeof g.Deno !== 'undefined';
  const isBun = typeof g.Bun !== 'undefined' || !!process?.versions?.bun;
  const isWorkerd = g.navigator?.userAgent === 'Cloudflare-Workers';
  const isFastly = typeof g.fastly !== 'undefined';
  const isNetlify = typeof g.Netlify !== 'undefined';
  const isEdgeLight = typeof g.EdgeRuntime !== 'undefined';
  // Matches std-env: true whenever a Node-compatible `process.versions.node` exists, even under
  // Bun/Deno's Node compat mode. The mutually-exclusive `runtime` name below still picks Bun/Deno first.
  const isNode = !!process?.versions?.node;
  const isBrowser = typeof g.window !== 'undefined' && typeof g.document !== 'undefined';

  // Priority order matches std-env's runtimeChecks.
  let runtime: JsRuntime;
  if (isNetlify) runtime = 'netlify';
  else if (isEdgeLight) runtime = 'edge-light';
  else if (isWorkerd) runtime = 'workerd';
  else if (isFastly) runtime = 'fastly';
  else if (isDeno) runtime = 'deno';
  else if (isBun) runtime = 'bun';
  else if (isNode) runtime = 'node';
  else if (isBrowser) runtime = 'browser';

  return {
    runtime,
    isNode,
    isDeno,
    isBun,
    isWorkerd,
    isFastly,
    isNetlify,
    isEdgeLight,
    isBrowser,
  };
}

export type OsPlatform = 'darwin' | 'win32' | 'linux' | undefined;

export interface OsInfo {
  platform: OsPlatform;
  isMac: boolean;
  isWindows: boolean;
  isLinux: boolean;
}

/**
 * Detects the current OS from `process.platform`. Pass a custom `processObj` for testing.
 * Only meaningful on Node/Bun/Deno; returns all-false when `process.platform` isn't available (e.g. browser, Workers).
 */
export function detectOs(processObj: any = (globalThis as any).process): OsInfo {
  const platform: OsPlatform = processObj?.platform;
  return {
    platform,
    isMac: platform === 'darwin',
    isWindows: platform === 'win32',
    isLinux: platform === 'linux',
  };
}
