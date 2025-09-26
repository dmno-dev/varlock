/* eslint-disable func-names, no-console, prefer-rest-params */

import { redactSensitiveConfig, varlockSettings } from './env';
import { debug } from './lib/debug';


/**
 * patches global console methods to redact sensitive config
 *
 * NOTE - this may not be 100% foolproof depending on the platform
 * */
export function patchGlobalConsole() {
  debug('⚡️ PATCHING global console methods');
  if ((console.log as any)._varlockPatchedFn) {
    debug('> already patched');
    return;
  }
  if (varlockSettings.redactLogs === false) {
    debug('> disabled by settings');
    return;
  }

  // our method of patching involves replacing an internal node method which may not be called if console.log itself has also been patched
  // for example AWS lambdas patches this to write the logs to a file which then is pushed to the rest of their system

  // so first we'll just patch the internal method do deal with normal stdout/stderr logs -------------------------------------

  // we need the internal symbol name to access the internal method
  const kWriteToConsoleSymbol = Object.getOwnPropertySymbols(globalThis.console).find((s) => s.description === 'kWriteToConsole');

  // @ts-ignore
  (globalThis as any)._varlockOrigWriteToConsoleFn ||= globalThis.console[kWriteToConsoleSymbol];
  // @ts-ignore
  globalThis.console[kWriteToConsoleSymbol] = function () {
    (globalThis as any)._varlockOrigWriteToConsoleFn.apply(this, [
      arguments[0],
      redactSensitiveConfig(arguments[1]),
      arguments[2],
    ]);
  };

  // and now we'll wrap console.log (and the other methods) if it looks like they have been patched already ------------------
  // NOTE - this will not fully redact from everything since we can't safely reach deep into objects
  // ideally we would only turn this when the above method does not work, but it's not trivial to detect when it that is the case
  // so we'll turn it on all the time for now...

  for (const logMethodName of ['trace', 'debug', 'info', 'log', 'info', 'warn', 'error']) {
    // @ts-ignore
    const originalLogMethod = globalThis.console[logMethodName];

    const patchedFn = function () {
      // @ts-ignore
      originalLogMethod.apply(this, Array.from(arguments).map(redactSensitiveConfig));
    };
    patchedFn._varlockPatchedFn = true;

    // @ts-ignore
    globalThis.console[logMethodName] = patchedFn;
  }
}

/**
 * restore's original global console methods to stop redacting secrets
 *
 * (only needed during local development when switching settings on/off in a process that does not reload)
 * */
export function unpatchGlobalConsole() {
  // we'll only care about the normal case where console.log has NOT been patched by something else... (see above)
  if (!(globalThis as any)._varlockOrigWriteToConsoleFn) return;

  const kWriteToConsoleSymbol = Object.getOwnPropertySymbols(globalThis.console).find((s) => s.description === 'kWriteToConsole');
  // @ts-ignore
  globalThis.console[kWriteToConsoleSymbol] = (globalThis as any)._varlockOrigWriteToConsoleFn;
  delete (globalThis as any)._varlockOrigWriteToConsoleFn;
}
