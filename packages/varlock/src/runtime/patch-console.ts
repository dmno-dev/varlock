/* eslint-disable func-names, no-console, prefer-rest-params */

import { redactSensitiveConfig, redactSensitiveConfigForOutput, varlockSettings } from './env';
import { debug } from './lib/debug';
import { isStreamRedactionPatched } from './lib/stream-patch-key';
import { patchProcessStreams } from './patch-process-streams';


/**
 * patches global console methods to redact sensitive config
 *
 * NOTE - this may not be 100% foolproof depending on the platform
 * */
export function patchGlobalConsole() {
  // stdout/stderr redaction is part of log redaction, and patching it here means every
  // integration that patches the console gets it too. A no-op unless opted in (and wherever
  // there are no process streams, e.g. edge runtimes)
  patchProcessStreams();

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

  // we need the internal symbol name to access the internal method (node only - bun and edge
  // runtimes don't have it)
  const kWriteToConsoleSymbol = Object.getOwnPropertySymbols(globalThis.console).find((s) => s.description === 'kWriteToConsole');

  if (kWriteToConsoleSymbol) {
    const nodeConsole = globalThis.console as any;
    (globalThis as any)._varlockOrigWriteToConsoleFn ||= nodeConsole[kWriteToConsoleSymbol];
    nodeConsole[kWriteToConsoleSymbol] = function () {
      // node calls this as (kUseStdout | kUseStderr, string) and writes to this._stdout / this._stderr.
      // If that stream is already redacted by the process stream patch, skip redacting twice
      const targetStream = (arguments[0] as symbol)?.description === 'kUseStderr' ? (this as any)._stderr : (this as any)._stdout;
      if (isStreamRedactionPatched(targetStream)) {
        return (globalThis as any)._varlockOrigWriteToConsoleFn.apply(this, arguments);
      }
      (globalThis as any)._varlockOrigWriteToConsoleFn.apply(this, [
        arguments[0],
        redactSensitiveConfigForOutput(arguments[1]),
        arguments[2],
      ]);
    };
  }

  // when node's internal method is patched, it (or the stream patch after it) writes the final
  // output, so the method wrapper below must leave unmask markers for it to handle. Otherwise
  // (bun, edge runtimes) the wrapper is the last layer
  const redactArg = kWriteToConsoleSymbol ? redactSensitiveConfig : redactSensitiveConfigForOutput;

  // and now we'll wrap console.log (and the other methods) if it looks like they have been patched already ------------------
  // NOTE - this will not fully redact from everything since we can't safely reach deep into objects
  // ideally we would only turn this when the above method does not work, but it's not trivial to detect when it that is the case
  // so we'll turn it on all the time for now...

  for (const logMethodName of ['trace', 'debug', 'info', 'log', 'warn', 'error']) {
    // @ts-ignore
    const originalLogMethod = globalThis.console[logMethodName];

    const patchedFn = function () {
      // @ts-ignore
      originalLogMethod.apply(this, Array.from(arguments).map(redactArg));
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
