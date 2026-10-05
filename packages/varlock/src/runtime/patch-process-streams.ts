/* eslint-disable func-names, prefer-rest-params */

import { fstatSync } from 'node:fs';
import { getRedactionHoldbackLength, redactSensitiveConfig, varlockSettings } from './env';
import { debug } from './lib/debug';
import { parseEnvToggle } from './lib/env-toggle';
import { FLUSH_TIMEOUT_MS, PARENT_REDACTED_STREAMS_ENV_VAR } from './lib/redact-stream';

type StreamName = 'stdout' | 'stderr';
type WriteCallback = (err?: Error | null) => void;
type WritableLike = {
  write: (...args: Array<any>) => boolean,
  isTTY?: boolean,
  fd?: number,
  writableNeedDrain?: boolean,
};

type StreamPatchState = {
  originalWrite: WritableLike['write'],
  /** text held back because it ends with what may be the start of a secret */
  pendingText: string,
  /** trailing bytes of an incomplete UTF-8 sequence, waiting for the rest of the character */
  pendingBytes: Uint8Array | undefined,
  /** callbacks of writes whose data is not fully written yet */
  pendingCallbacks: Array<WriteCallback>,
  flushTimer: ReturnType<typeof setTimeout> | undefined,
};

// shared across module instances (e.g. auto-load + an integration's init-server bundle)
const PATCH_STATE_KEY = Symbol.for('varlock.streamRedaction');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

function isRegularFile(stream: WritableLike): boolean {
  if (typeof stream.fd !== 'number') return false;
  try {
    return fstatSync(stream.fd).isFile();
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
): boolean {
  const override = parseEnvToggle(env._VARLOCK_REDACT_STDOUT);
  if (override === false) return false;
  // a parent `varlock run` already pipes this stream through redaction - unless something in
  // between redirected it to a file (e.g. `varlock run -- sh -c 'node app.js > out.log'`)
  const parentRedacted = env[PARENT_REDACTED_STREAMS_ENV_VAR]?.split(',') ?? [];
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

/** combine queued callbacks into one, clearing the queue */
function takeCallbacks(state: StreamPatchState): WriteCallback | undefined {
  if (!state.pendingCallbacks.length) return undefined;
  const callbacks = state.pendingCallbacks;
  state.pendingCallbacks = [];
  return (err) => {
    for (const cb of callbacks) cb(err);
  };
}

function clearFlushTimer(state: StreamPatchState) {
  if (state.flushTimer !== undefined) {
    clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
  }
}

/** write out everything held back, firing any callbacks waiting on it */
function flushPending(stream: WritableLike, state: StreamPatchState) {
  clearFlushTimer(state);
  const text = state.pendingText;
  const bytes = state.pendingBytes;
  state.pendingText = '';
  state.pendingBytes = undefined;
  const done = takeCallbacks(state);
  if (text) state.originalWrite.call(stream, redactSensitiveConfig(text), bytes?.length ? undefined : done);
  if (bytes?.length) state.originalWrite.call(stream, bytes, done);
  if (!text && !bytes?.length && done) queueMicrotask(() => done());
}

function scheduleFlush(stream: WritableLike, state: StreamPatchState) {
  if (!state.pendingText && !state.pendingBytes) return;
  state.flushTimer = setTimeout(() => flushPending(stream, state), FLUSH_TIMEOUT_MS);
  // don't let a pending flush keep the process alive (held text is flushed on exit)
  state.flushTimer.unref?.();
}

function writeText(
  stream: WritableLike,
  state: StreamPatchState,
  text: string,
  cb: WriteCallback | undefined,
): boolean {
  clearFlushTimer(state);
  state.pendingText += text;
  // hold back a trailing partial match, so a secret split across writes is still caught
  const holdbackLength = getRedactionHoldbackLength(state.pendingText);
  const emittable = holdbackLength ? state.pendingText.slice(0, -holdbackLength) : state.pendingText;
  state.pendingText = holdbackLength ? state.pendingText.slice(-holdbackLength) : '';
  if (cb) state.pendingCallbacks.push(cb);

  // a write's callback fires once all of its data (and everything before it) is out
  const done = !state.pendingText && !state.pendingBytes ? takeCallbacks(state) : undefined;
  let result = true;
  if (emittable) {
    result = state.originalWrite.call(stream, redactSensitiveConfig(emittable), done);
  } else {
    if (done) queueMicrotask(() => done());
    result = !stream.writableNeedDrain;
  }
  scheduleFlush(stream, state);
  return result;
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
    pendingText: '',
    pendingBytes: undefined,
    pendingCallbacks: [],
    flushTimer: undefined,
  };
  (stream as any)[PATCH_STATE_KEY] = state;

  stream.write = function (this: WritableLike, chunk: any, encodingOrCb?: any, maybeCb?: any) {
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
  return true;
}

/** restores the original `write` (flushing anything held back). Mostly for tests. */
export function unpatchStreamWrite(stream: WritableLike) {
  const state: StreamPatchState | undefined = (stream as any)[PATCH_STATE_KEY];
  if (!state) return;
  flushPending(stream, state);
  stream.write = state.originalWrite;
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
    if (stream) {
      // keep ordering with anything held back by the process.stdout patch
      flushStreamWrite(stream);
      const args = Array.from(arguments);
      if (typeof data === 'string') {
        args[1] = redactSensitiveConfig(data);
      } else if (data instanceof Uint8Array) {
        try {
          const redacted = redactSensitiveConfig(utf8Decoder.decode(data));
          args[1] = utf8Encoder.encode(redacted);
        } catch {
          // binary - leave untouched
        }
      }
      return originalBunWrite.apply(this, args);
    }
    return originalBunWrite.apply(this, arguments);
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
