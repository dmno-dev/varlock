/* eslint-disable func-names, prefer-rest-params */

import { redactSensitiveConfig, varlockSettings } from './env';
import { createRedactedStreamWriter } from './lib/redact-stream';
import { debug } from './lib/debug';

type WriteCallback = (err?: Error | null) => void;
type StdStream = {
  isTTY?: boolean,
  write: (...args: Array<any>) => boolean,
};

/**
 * Same accepted values as the CLI's `parseEnvToggle` (see `_VARLOCK_REDACT_STDOUT`): only
 * `1`/`true` and `0`/`false`, case-insensitive. Anything else counts as not set.
 */
function getRedactStdoutOverride(): boolean | undefined {
  const normalized = process.env._VARLOCK_REDACT_STDOUT?.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
}

function isUtf8(encoding: string) {
  const normalized = encoding.toLowerCase();
  return normalized === 'utf8' || normalized === 'utf-8';
}

/**
 * wraps a stream's `write` so sensitive config is redacted from the text passing through
 *
 * Text that ends with what could be the start of a sensitive value is held back until the
 * next write (or a short timeout), so a value split across two writes is still caught.
 */
function patchStreamWrite(stream: StdStream) {
  if ((stream.write as any)._varlockPatchedFn) {
    debug('> already patched');
    return;
  }
  const originalWrite = stream.write;

  // the callback and return value of the write call in progress, so both still reach
  // the caller although the write goes through the redacting writer
  let pendingCallback: WriteCallback | undefined;
  let lastWriteResult = true;

  const writer = createRedactedStreamWriter({
    write(str: string) {
      const callback = pendingCallback;
      pendingCallback = undefined;
      lastWriteResult = originalWrite.call(stream, str, callback);
      return lastWriteResult;
    },
  });

  // held back text must not be lost when the process ends before the timeout:
  // `beforeExit` lets the write finish when the event loop runs dry, and `exit` is
  // the last chance on an explicit `process.exit()`
  const flushOnExit = () => writer.flush();
  process.on('beforeExit', flushOnExit);
  process.on('exit', flushOnExit);

  const patchedFn = function (chunk: any, encodingOrCallback?: any, maybeCallback?: any) {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const callback: WriteCallback | undefined = typeof encodingOrCallback === 'function'
      ? encodingOrCallback
      : maybeCallback;

    if (typeof chunk !== 'string' || (encoding && !isUtf8(encoding))) {
      // text held back from an earlier write goes out first, to keep the order
      writer.flush();
      // stdout can carry binary data, so bytes pass through untouched unless they hold a
      // whole sensitive value (strings in another encoding, e.g. hex, always pass through)
      if (chunk instanceof Uint8Array) {
        const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
        const redacted = redactSensitiveConfig(text);
        if (redacted !== text) return originalWrite.call(stream, redacted, callback);
      }
      return originalWrite.apply(stream, arguments as any);
    }

    pendingCallback = callback;
    lastWriteResult = true;
    writer.write(chunk);
    if (pendingCallback) {
      // nothing was written (all of it is held back, or the chunk was empty),
      // but the caller still expects its callback
      pendingCallback = undefined;
      queueMicrotask(() => callback!());
    }
    return lastWriteResult;
  };
  patchedFn._varlockPatchedFn = true;
  patchedFn._varlockRestore = () => {
    writer.flush();
    process.off('beforeExit', flushOnExit);
    process.off('exit', flushOnExit);
    stream.write = originalWrite;
  };

  stream.write = patchedFn;
}

/**
 * patches `process.stdout.write` / `process.stderr.write` to redact sensitive config
 *
 * `patchGlobalConsole` only covers the console methods, while loggers and CLI libraries
 * often write to the streams directly. This follows the same rule as `varlock run`: a stream
 * attached to an interactive terminal is left alone, a piped or redirected one is redacted.
 * `_VARLOCK_REDACT_STDOUT` turns it off (`0`), or on despite `@redactLogs=false` (`1`).
 *
 * NOTE - output that bypasses these streams is not covered (e.g. writing to the file
 * descriptor directly, or `Bun.write(Bun.stdout, ...)`)
 * */
export function patchGlobalStdStreams() {
  debug('⚡️ PATCHING process.stdout/stderr writes');
  const override = getRedactStdoutOverride();
  if (override === false) {
    debug('> disabled by _VARLOCK_REDACT_STDOUT');
    return;
  }
  if (varlockSettings.redactLogs === false && !override) {
    debug('> disabled by settings');
    return;
  }

  for (const streamName of ['stdout', 'stderr'] as const) {
    const stream = process[streamName] as StdStream | undefined;
    if (!stream || typeof stream.write !== 'function') continue;
    if (stream.isTTY) {
      debug(`> ${streamName} is a TTY, leaving it alone`);
      continue;
    }
    patchStreamWrite(stream);
  }
}

/**
 * restores the original `process.stdout.write` / `process.stderr.write`
 *
 * (only needed during local development when switching settings on/off in a process that does not reload)
 * */
export function unpatchGlobalStdStreams() {
  for (const streamName of ['stdout', 'stderr'] as const) {
    (process[streamName]?.write as any)?._varlockRestore?.();
  }
}
