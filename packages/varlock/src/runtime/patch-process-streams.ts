/* eslint-disable func-names, prefer-rest-params */

import { getStreamHoldbackLength, redactSensitiveConfigForOutput, varlockSettings } from './env';
import { debug } from './lib/debug';
import { parseEnvToggle } from './lib/env-toggle';
import { FLUSH_TIMEOUT_MS, getParentRedactedStreams } from './lib/redact-stream';
import { STREAM_PATCH_STATE_KEY as PATCH_STATE_KEY } from './lib/stream-patch-key';

type StreamName = 'stdout' | 'stderr';
type WriteCallback = (err?: Error | null) => void;
type WritableLike = {
  write: (...args: Array<any>) => boolean,
  end?: (...args: Array<any>) => any,
  isTTY?: boolean,
  fd?: number,
  writableNeedDrain?: boolean,
  writableEnded?: boolean,
  destroyed?: boolean,
  errored?: Error | null,
};

type StreamPatchState = {
  originalWrite: WritableLike['write'],
  originalEnd: WritableLike['end'],
  /** text held back because it ends with what may be the start of a secret */
  pendingText: string,
  /** trailing bytes of an incomplete UTF-8 sequence, waiting for the rest of the character */
  pendingBytes: Uint8Array | undefined,
  flushTimer: ReturnType<typeof setTimeout> | undefined,
};


const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

function isRegularFile(stream: WritableLike): boolean {
  if (typeof stream.fd !== 'number') return false;
  try {
    // no static node:fs import - this module is also bundled into edge runtimes via patch-console
    const fs = (globalThis.process as any)?.getBuiltinModule?.('node:fs');
    return !!fs?.fstatSync(stream.fd).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether `process.stdout` / `process.stderr` should be redacted in this process.
 *
 * Same rule as `varlock run`: only streams that are not a TTY (a human at a terminal can
 * already see the values; piped/redirected output is what persists and what agents read).
 * `_VARLOCK_REDACT_STDOUT` forces it on or off.
 *
 * Opt-in for now via `@redactLogs={stdout=true}` (or the env var). Planned to become the
 * default (when unset) in the next major, matching `varlock run`.
 */
export function shouldRedactProcessStream(
  streamName: StreamName,
  stream: WritableLike,
  env: Record<string, string | undefined> = process.env,
  ppid: number | undefined = process.ppid,
): boolean {
  const override = parseEnvToggle(env._VARLOCK_REDACT_STDOUT);
  if (override === false) return false;
  // our parent `varlock run` already pipes this stream through redaction - unless the stream
  // was redirected to a file on the way (e.g. `varlock run -- bash -c 'exec node app.js > out.log'`)
  const parentRedacted = getParentRedactedStreams(env, ppid);
  if (parentRedacted.includes(streamName) && !isRegularFile(stream)) return false;
  if (override === true) return true;
  if (varlockSettings.redactStdout !== true) return false;
  return !stream.isTTY;
}

/** length of a trailing incomplete UTF-8 sequence (0 if the bytes end on a character boundary) */
function incompleteUtf8TailLength(bytes: Uint8Array): number {
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 3); i--) {
    const byte = bytes[i];
    // continuation byte (10xxxxxx) - keep looking for the lead byte
    if (byte >= 0x80 && byte < 0xC0) continue;
    let needed = 1;
    if (byte >= 0xF0) needed = 4;
    else if (byte >= 0xE0) needed = 3;
    else if (byte >= 0xC0) needed = 2;
    const have = bytes.length - i;
    return have < needed ? have : 0;
  }
  return 0;
}

function concatBytes(a: Uint8Array | undefined, b: Uint8Array): Uint8Array {
  if (!a?.length) return b;
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

function clearFlushTimer(state: StreamPatchState) {
  if (state.flushTimer !== undefined) {
    clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
  }
}

/**
 * Write out everything held back. Held text is the stream's own buffer: the writes it came
 * from have already been acknowledged, so a failure here surfaces as the stream's error event.
 */
function flushPending(stream: WritableLike, state: StreamPatchState) {
  clearFlushTimer(state);
  const text = state.pendingText;
  const bytes = state.pendingBytes;
  state.pendingText = '';
  state.pendingBytes = undefined;
  if (text) state.originalWrite.call(stream, redactSensitiveConfigForOutput(text));
  if (bytes?.length) state.originalWrite.call(stream, bytes);
}

function scheduleFlush(stream: WritableLike, state: StreamPatchState) {
  if (!state.pendingText && !state.pendingBytes) return;
  state.flushTimer = setTimeout(() => flushPending(stream, state), FLUSH_TIMEOUT_MS);
  // don't let a pending flush keep the process alive (held text is flushed on exit)
  state.flushTimer.unref?.();
}

/**
 * Adds text to what the stream is holding back and returns the redacted part that can be
 * written now. A trailing partial match stays held (see getStreamHoldbackLength).
 */
function takeEmittableText(stream: WritableLike, state: StreamPatchState, text: string): string {
  clearFlushTimer(state);
  state.pendingText += text;
  const holdbackLength = getStreamHoldbackLength(state.pendingText);
  const emittable = holdbackLength ? state.pendingText.slice(0, -holdbackLength) : state.pendingText;
  state.pendingText = holdbackLength ? state.pendingText.slice(-holdbackLength) : '';
  scheduleFlush(stream, state);
  return emittable && redactSensitiveConfigForOutput(emittable);
}

/**
 * A write's callback fires once the part of it that could be written has been (with that
 * write's error, if any). Waiting for held-back text instead would make writers that wait on
 * each callback before writing more (e.g. `await Bun.write(...)` in a loop) force every held
 * prefix out by timeout, unredacted, before the rest of the value arrives. Held text still
 * goes out on the next write, `end()`, the flush timer, or process exit.
 */
function writeText(
  stream: WritableLike,
  state: StreamPatchState,
  text: string,
  cb: WriteCallback | undefined,
): boolean {
  const emittable = takeEmittableText(stream, state, text);
  if (emittable) return state.originalWrite.call(stream, emittable, cb);
  if (cb) queueMicrotask(() => cb());
  return !stream.writableNeedDrain;
}

/**
 * Replaces `stream.write` with a version that redacts sensitive values. Only UTF-8 text is
 * rewritten: strings (with no or a utf8 encoding) and buffers that decode as valid UTF-8.
 * Anything else (binary data, base64/hex strings) passes through untouched.
 *
 * Returns false if the stream was already patched.
 */
export function patchStreamWrite(stream: WritableLike): boolean {
  if ((stream as any)[PATCH_STATE_KEY]) return false;
  const state: StreamPatchState = {
    originalWrite: stream.write,
    originalEnd: stream.end,
    pendingText: '',
    pendingBytes: undefined,
    flushTimer: undefined,
  };
  (stream as any)[PATCH_STATE_KEY] = state;

  stream.write = function (this: WritableLike, chunk: any, encodingOrCb?: any, maybeCb?: any) {
    // a stream that can no longer accept writes rejects this one (ERR_STREAM_WRITE_AFTER_END,
    // ERR_STREAM_DESTROYED, ...) without writing anything, so let it report that itself rather
    // than buffering the text and acknowledging it
    if (stream.writableEnded || stream.destroyed || stream.errored) {
      return state.originalWrite.apply(stream, arguments as any);
    }
    const cb: WriteCallback | undefined = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb.toLowerCase() : undefined;

    if (typeof chunk === 'string' && (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8')) {
      // an incomplete character from a previous buffer can't join a string - emit it as-is
      if (state.pendingBytes) flushPending(stream, state);
      return writeText(stream, state, chunk, cb);
    }

    if (chunk instanceof Uint8Array) {
      const bytes = concatBytes(state.pendingBytes, chunk);
      const tailLength = incompleteUtf8TailLength(bytes);
      let text: string | undefined;
      try {
        text = utf8Decoder.decode(tailLength ? bytes.subarray(0, bytes.length - tailLength) : bytes);
      } catch {
        // not valid UTF-8 - treat as binary
      }
      if (text !== undefined) {
        state.pendingBytes = tailLength ? bytes.slice(bytes.length - tailLength) : undefined;
        return writeText(stream, state, text, cb);
      }
    }

    // not text we can safely rewrite - flush anything held back (to keep ordering), then pass
    // the write through untouched
    flushPending(stream, state);
    return state.originalWrite.apply(stream, arguments as any);
  };

  // held-back output must go out before the stream ends (otherwise it is lost, or flushed
  // after the end and errors with ERR_STREAM_WRITE_AFTER_END)
  if (typeof state.originalEnd === 'function') {
    stream.end = function (this: WritableLike, chunk?: any, encodingOrCb?: any, maybeCb?: any) {
      let cb = maybeCb;
      let encoding = encodingOrCb;
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = undefined;
        encoding = undefined;
      } else if (typeof encodingOrCb === 'function') {
        cb = encodingOrCb;
        encoding = undefined;
      }
      // the final chunk goes through the redacting write like any other
      if (chunk !== undefined && chunk !== null) stream.write(chunk, encoding);
      flushPending(stream, state);
      return state.originalEnd!.call(stream, cb);
    };
  }
  return true;
}

/** restores the original `write` (flushing anything held back). Mostly for tests. */
export function unpatchStreamWrite(stream: WritableLike) {
  const state: StreamPatchState | undefined = (stream as any)[PATCH_STATE_KEY];
  if (!state) return;
  flushPending(stream, state);
  stream.write = state.originalWrite;
  if (state.originalEnd) stream.end = state.originalEnd;
  delete (stream as any)[PATCH_STATE_KEY];
}

/** flush anything a patched stream is holding back (e.g. right before exiting) */
export function flushStreamWrite(stream: WritableLike) {
  const state: StreamPatchState | undefined = (stream as any)[PATCH_STATE_KEY];
  if (state) flushPending(stream, state);
}

/** wrap `Bun.write(Bun.stdout | Bun.stderr, ...)`, which bypasses `process.stdout.write` */
function patchBunWrite(patchedStreams: Partial<Record<StreamName, WritableLike>>) {
  const bun = (globalThis as any).Bun;
  if (!bun || typeof bun.write !== 'function' || bun.write._varlockPatchedFn) return;
  const originalBunWrite = bun.write;
  const patchedBunWrite = function (this: any, destination: any, data: any) {
    let streamName: StreamName | undefined;
    if (destination === bun.stdout) streamName = 'stdout';
    else if (destination === bun.stderr) streamName = 'stderr';
    const stream = streamName && patchedStreams[streamName];
    const state: StreamPatchState | undefined = stream && (stream as any)[PATCH_STATE_KEY];
    if (!stream || !state) return originalBunWrite.apply(this, arguments);

    let text: string | undefined;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof Uint8Array) {
      try {
        text = utf8Decoder.decode(data);
      } catch {
        // binary - leave untouched
      }
    }
    if (text === undefined) {
      // keep ordering with anything held back
      flushPending(stream, state);
      return originalBunWrite.apply(this, arguments);
    }

    // shares holdback state with process.stdout.write, so a value split across writes of either
    // kind is still caught, but writes with Bun's own writer: its failures only reject the
    // promise, while the process stream would also emit an (often unhandled) error event.
    // Bun.write resolves to the bytes written; report the caller's own byte count
    if (state.pendingBytes) flushPending(stream, state);
    const emittable = takeEmittableText(stream, state, text);
    const byteLength = typeof data === 'string' ? utf8Encoder.encode(data).length : data.length;
    if (!emittable) return Promise.resolve(byteLength);
    return Promise.resolve(originalBunWrite.call(this, destination, emittable)).then(() => byteLength);
  };
  patchedBunWrite._varlockPatchedFn = true;
  bun.write = patchedBunWrite;
}

/**
 * Patches `process.stdout.write` / `process.stderr.write` (and `Bun.write` to those streams)
 * to redact sensitive values, for streams where `shouldRedactProcessStream` says so.
 *
 * Complements the console patch: it also catches loggers and libraries that write to the
 * streams directly (pino, CLI frameworks, `child.stdout.pipe(process.stdout)`). Writes that
 * bypass the stream objects entirely (e.g. `fs.writeSync(1, ...)`, pino destinations and
 * worker-thread transports) are only covered by running under `varlock run`.
 */
export function patchProcessStreams() {
  if (typeof process === 'undefined') return;
  const patchedStreams: Partial<Record<StreamName, WritableLike>> = {};
  for (const streamName of ['stdout', 'stderr'] as const) {
    const stream = process[streamName] as unknown as WritableLike | undefined;
    if (!stream || typeof stream.write !== 'function') continue;
    if ((stream as any)[PATCH_STATE_KEY]) {
      patchedStreams[streamName] = stream;
      continue;
    }
    if (!shouldRedactProcessStream(streamName, stream)) continue;
    debug(`⚡️ PATCHING process.${streamName}.write`);
    patchStreamWrite(stream);
    patchedStreams[streamName] = stream;
    // anything still held back must go out before the process exits
    process.on('exit', () => flushStreamWrite(stream));
  }
  if (patchedStreams.stdout || patchedStreams.stderr) patchBunWrite(patchedStreams);
}
