/* eslint-disable func-names, prefer-rest-params */

import { redactSensitiveConfig, varlockSettings } from './env';
import { createRedactedStreamWriter, type StreamWriteCallback } from './lib/redact-stream';
import { debug } from './lib/debug';

type StdStream = {
  isTTY?: boolean,
  writableNeedDrain?: boolean,
  write: (...args: Array<any>) => boolean,
};

/** Same accepted values as the CLI's `parseEnvToggle` */
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

function patchStreamWrite(stream: StdStream) {
  if ((stream.write as any)._varlockPatchedFn) {
    debug('> already patched');
    return;
  }
  const originalWrite = stream.write;

  const writer = createRedactedStreamWriter({
    write: (str: string, callback?: StreamWriteCallback) => originalWrite.call(stream, str, callback),
  });

  // held back text must go out before the process ends: `beforeExit` covers the event
  // loop running dry, `exit` an explicit `process.exit()`
  const flushOnExit = () => writer.flush();
  process.on('beforeExit', flushOnExit);
  process.on('exit', flushOnExit);

  const patchedFn = function (chunk: any, encodingOrCallback?: any, maybeCallback?: any) {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const callback: StreamWriteCallback | undefined = typeof encodingOrCallback === 'function'
      ? encodingOrCallback
      : maybeCallback;

    if (typeof chunk !== 'string' || (encoding && !isUtf8(encoding))) {
      // text held back from an earlier write goes out first, to keep the order
      writer.flush();
      // stdout can carry binary data: bytes pass through untouched unless they hold a
      // sensitive value
      if (chunk instanceof Uint8Array) {
        const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
        const redacted = redactSensitiveConfig(text);
        if (redacted !== text) return originalWrite.call(stream, redacted, callback);
      }
      return originalWrite.apply(stream, arguments as any);
    }

    const result = writer.write(chunk, callback);
    // all of it is held back, so no write happened: report the stream's own backpressure
    return result ?? !stream.writableNeedDrain;
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
 * Same rule as `varlock run`: a TTY is left alone, a piped or redirected stream is redacted.
 * `_VARLOCK_REDACT_STDOUT` turns it off (`0`), or on despite `@redactLogs=false` (`1`).
 *
 * NOTE - output that bypasses these streams is not covered (e.g. `fs.writeSync(1, ...)`)
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

/** restores the original `process.stdout.write` / `process.stderr.write` */
export function unpatchGlobalStdStreams() {
  for (const streamName of ['stdout', 'stderr'] as const) {
    (process[streamName]?.write as any)?._varlockRestore?.();
  }
}
