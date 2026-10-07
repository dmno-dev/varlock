/* eslint-disable func-names, prefer-rest-params */

import { getRedactSettings } from './env';
import { debug } from './lib/debug';
import { parseEnvToggle } from './lib/env-toggle';
import { getParentRedactedStreams, redactStreamWrite } from './lib/redact-stream';
import { STREAM_PATCH_STATE_KEY as PATCH_STATE_KEY } from './lib/stream-patch-key';

type StreamName = 'stdout' | 'stderr';
type WritableLike = {
  write: (...args: Array<any>) => boolean,
  end?: (...args: Array<any>) => any,
  isTTY?: boolean,
  fd?: number,
};

type StreamPatchState = {
  originalWrite: WritableLike['write'],
  originalEnd: WritableLike['end'],
  /** end of the previous write that could be the start of a sensitive value */
  carry: string,
  /**
   * the incomplete UTF-8 sequence a previous byte write ended with (already written raw). The
   * next write completes the character, which then counts as written text for matching, so a
   * value split inside a multi-byte character is still recognized.
   */
  pendingBytes: Uint8Array,
};

const NO_BYTES = new Uint8Array(0);

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
 * Opt-in for now via `@redact={stdout=true}` (or the env var). Planned to become the
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
  if (getRedactSettings().stdout !== true) return false;
  return !stream.isTTY;
}

const SPLIT_WARNED_KEY = Symbol.for('varlock.splitValueWarned');

/** once per process: a value split across writes had its first part printed */
function warnSplitValue(key: string) {
  if ((globalThis as any)[SPLIT_WARNED_KEY]) return;
  (globalThis as any)[SPLIT_WARNED_KEY] = true;
  // eslint-disable-next-line no-console
  console.warn([
    `[varlock] the sensitive value of ${key} was split across separate writes to stdout/stderr,`,
    'so its first part was printed before it could be recognized (the rest was redacted).',
    'Run under `varlock run` to redact output split across writes.',
  ].join(' '));
}

/** `written` is text that already went out before `text` (a character completed by this write) */
function redactText(state: StreamPatchState, text: string, written = ''): string {
  const { output, carry, splitKey } = redactStreamWrite(state.carry + written, text);
  state.carry = carry;
  if (splitKey) warnSplitValue(splitKey);
  return output;
}

/** count of leading UTF-8 continuation bytes (the rest of a character split off a previous write) */
function leadingContinuationBytes(bytes: Uint8Array): number {
  let count = 0;
  while (count < Math.min(3, bytes.length) && bytes[count] >= 0x80 && bytes[count] < 0xC0) count++;
  return count;
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

/**
 * Redacts the UTF-8 text in a buffer. Bytes of a character split across writes stay as they
 * are at either end (the character is completed on the next write and matched as written
 * text); anything that is not valid UTF-8 is binary and is returned untouched.
 */
function redactBytes(state: StreamPatchState, bytes: Uint8Array): Uint8Array {
  const start = leadingContinuationBytes(bytes);
  const end = bytes.length - incompleteUtf8TailLength(bytes.subarray(start));
  // the character the previous write ended in the middle of, now complete
  let completedChar = '';
  if (state.pendingBytes.length) {
    const sequence = new Uint8Array(state.pendingBytes.length + start);
    sequence.set(state.pendingBytes);
    sequence.set(bytes.subarray(0, start), state.pendingBytes.length);
    try {
      completedChar = utf8Decoder.decode(sequence);
    } catch {
      // still incomplete (a character spread over three writes), or not a character at all
      if (sequence.length < 4 && start === bytes.length) {
        state.pendingBytes = sequence;
        return bytes;
      }
    }
  }
  state.pendingBytes = end < bytes.length ? bytes.slice(end) : NO_BYTES;
  let text: string;
  try {
    text = utf8Decoder.decode(bytes.subarray(start, end));
  } catch {
    // binary: breaks the text, so nothing carries over
    state.carry = '';
    state.pendingBytes = NO_BYTES;
    return bytes;
  }
  const redacted = redactText(state, text, completedChar);
  if (redacted === text) return bytes;
  const encoded = utf8Encoder.encode(redacted);
  const out = new Uint8Array(start + encoded.length + (bytes.length - end));
  out.set(bytes.subarray(0, start));
  out.set(encoded, start);
  out.set(bytes.subarray(end), start + encoded.length);
  // keep Buffer methods for code that inspects what was written
  return typeof Buffer !== 'undefined' ? Buffer.from(out.buffer, out.byteOffset, out.length) : out;
}

/** the redacted version of a chunk, or the chunk itself if it isn't UTF-8 text */
function redactChunk(state: StreamPatchState, chunk: unknown, encoding: unknown): unknown {
  if (typeof chunk === 'string') {
    const normalized = typeof encoding === 'string' ? encoding.toLowerCase() : undefined;
    // other encodings (base64, hex, ...) are data, not text we can safely rewrite
    // a string write ends any byte sequence a previous buffer left open
    state.pendingBytes = NO_BYTES;
    if (normalized === undefined || normalized === 'utf8' || normalized === 'utf-8') return redactText(state, chunk);
    state.carry = '';
    return chunk;
  }
  if (chunk instanceof Uint8Array) return redactBytes(state, chunk);
  return chunk;
}

/**
 * Replaces `stream.write` (and `stream.end`, which can carry a final chunk) with versions that
 * redact sensitive values in UTF-8 text and otherwise pass the call through unchanged: same
 * arguments, callback, and return value, and nothing is held back.
 *
 * A value split across two writes is caught when the second write arrives: its part in that
 * write is masked, and a one-time warning says the first part was already printed.
 *
 * Returns false if the stream was already patched.
 */
export function patchStreamWrite(stream: WritableLike): boolean {
  if ((stream as any)[PATCH_STATE_KEY]) return false;
  const state: StreamPatchState = {
    originalWrite: stream.write,
    originalEnd: stream.end,
    carry: '',
    pendingBytes: NO_BYTES,
  };
  (stream as any)[PATCH_STATE_KEY] = state;

  stream.write = function (this: WritableLike, chunk: any) {
    const args = Array.from(arguments);
    args[0] = redactChunk(state, chunk, args[1]);
    return state.originalWrite.apply(stream, args);
  };

  if (typeof state.originalEnd === 'function') {
    stream.end = function (this: WritableLike, chunk?: any) {
      const args = Array.from(arguments);
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
        args[0] = redactChunk(state, chunk, args[1]);
      }
      return state.originalEnd!.apply(stream, args);
    };
  }
  return true;
}

/** restores the original `write` and `end`. Mostly for tests. */
export function unpatchStreamWrite(stream: WritableLike) {
  const state: StreamPatchState | undefined = (stream as any)[PATCH_STATE_KEY];
  if (!state) return;
  stream.write = state.originalWrite;
  if (state.originalEnd) stream.end = state.originalEnd;
  delete (stream as any)[PATCH_STATE_KEY];
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
    if (!state) return originalBunWrite.apply(this, arguments);
    // shares the carry with process.stdout.write, so a value split across writes of either kind
    // is still caught. Other data (Blob, Response, ...) passes through
    const args = Array.from(arguments);
    args[1] = redactChunk(state, data, undefined);
    return originalBunWrite.apply(this, args);
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
 *
 * Called alongside `patchGlobalConsole` by the node entry points (auto-load, init-server, the
 * framework integrations). Kept out of `patchGlobalConsole` itself so the edge bundles, which
 * have no process streams, don't carry this code. A no-op unless opted in.
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
  }
  if (patchedStreams.stdout || patchedStreams.stderr) patchBunWrite(patchedStreams);
}
