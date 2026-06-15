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
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(candidate);
      if (typeof mod?.headers === 'function') {
        debug(`resolved headers() from ${candidate}`);
        cachedHeadersFn = mod.headers;
        return cachedHeadersFn;
      }
    } catch (err) {
      debug(`failed loading ${candidate}: ${String((err as any)?.message ?? err)}`);
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
