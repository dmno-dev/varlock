type DynamicConfigAccessMeta = {
  key: string,
  isPublic: boolean,
};

type DynamicConfigAccessHook = ((meta: DynamicConfigAccessMeta) => void) & {
  _varlockNextjsWrapped?: boolean,
};

let cachedHeadersFn: undefined | (() => unknown) | null;

function debug(...args: Array<any>) {
  if (!process.env.DEBUG_VARLOCK_NEXT_INTEGRATION) return;
  // eslint-disable-next-line no-console
  console.log('[varlock-next-dynamic-access]', ...args);
}

function getNextHeadersFn() {
  if (cachedHeadersFn !== undefined) return cachedHeadersFn;
  const candidates = [
    'next/headers',
    'next/dist/api/headers',
    'next/dist/server/request/headers',
  ];
  // When this module is bundled (turbopack, webpack-bundled layers), the bundler
  // rewrites require() and resolves the right module instance. When it stays
  // external (webpack server externals), require() resolves from THIS package's
  // context - under pnpm isolation `next` is not reachable there, so also try
  // resolving from the app root. That fallback must not use a static builtin
  // import (bundlers try to resolve it when this file gets bundled into
  // restricted contexts) - process.getBuiltinModule is invisible to them.
  const appRequire = (id: string) => {
    const nodeModule = (globalThis as any).process?.getBuiltinModule?.('node:module');
    if (!nodeModule?.createRequire) throw new Error('createRequire unavailable');
    return nodeModule.createRequire(`${process.cwd()}/package.json`)(id);
  };
  const loaders: Array<(id: string) => any> = [
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (id) => require(id),
    appRequire,
  ];
  for (const candidate of candidates) {
    for (const load of loaders) {
      try {
        const mod = load(candidate);
        if (typeof mod?.headers === 'function') {
          debug(`resolved headers() from ${candidate}`);
          cachedHeadersFn = mod.headers;
          return cachedHeadersFn;
        }
      } catch (err) {
        debug(`failed loading ${candidate}: ${String((err as any)?.message ?? err)}`);
      }
    }
  }
  cachedHeadersFn = null;
  return cachedHeadersFn;
}

/**
 * Installs a global callback used by varlock/env on dynamic ENV access.
 * During valid Next request rendering, calling headers() marks the route dynamic.
 */
export function initVarlockNextDynamicAccess() {
  const existingHook = (globalThis as any).__varlockOnDynamicConfigAccess as DynamicConfigAccessHook | undefined;
  if (existingHook?._varlockNextjsWrapped) return;
  debug('installing dynamic config access hook');

  const wrappedHook: DynamicConfigAccessHook = (meta) => {
    existingHook?.(meta);
    if (!meta) return;
    debug(`hook invoked for key=${meta.key} isPublic=${meta.isPublic}`);

    // Only dynamic+PUBLIC keys force the route dynamic - their whole point is
    // runtime freshness, so baking one into prerendered output would be wrong.
    // Sensitive keys are dynamic by default, and reading one server-side during
    // prerender is legitimate (leak scanning polices the rendered output) -
    // forcing headers() there would break static/export builds.
    if (!meta.isPublic) return;

    const headersFn = getNextHeadersFn();
    if (!headersFn) {
      debug('next/headers headers() function unavailable');
      return;
    }

    try {
      debug(`calling headers() for ENV.${meta.key}`);
      headersFn();
      debug(`headers() call completed for ENV.${meta.key}`);
    } catch (err) {
      // headers() is only valid in request render contexts.
      // Outside that context we no-op so build/module init paths don't break.
      const msg = String((err as any)?.message ?? err ?? '');
      if (
        msg.includes('outside a request scope')
        || msg.includes('outside of a request')
        || msg.includes('requestAsyncStorage')
      ) {
        debug(`headers() no-op outside request context for ENV.${meta.key}: ${msg}`);
        return;
      }
      debug(`headers() threw for ENV.${meta.key}: ${msg}`);
      throw err;
    }
  };

  wrappedHook._varlockNextjsWrapped = true;
  (globalThis as any).__varlockOnDynamicConfigAccess = wrappedHook;
}
