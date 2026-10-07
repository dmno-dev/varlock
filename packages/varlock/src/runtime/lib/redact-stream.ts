import {
  findMatchCrossing, findSplitValueCompletion, getRedactionHoldbackLength,
  redactSensitiveConfig, redactSensitiveConfigForOutput, UNMASK_PREFIX,
} from '../env';

/**
 * how long to hold back a possible partial secret before giving up and flushing —
 * chunks split mid-secret (e.g. at pipe buffer boundaries) arrive back-to-back in
 * practice, so this only triggers when output genuinely ends with a secret-prefix lookalike
 */
export const FLUSH_TIMEOUT_MS = 100;

/** mask for the part of a split value that arrives after its first part was already written */
export const SPLIT_VALUE_MASK = '▒▒▒▒▒';

/**
 * Set by `varlock run` / `varlock proxy run` on the child's env: `<parent pid>:<streams>`,
 * where streams is a comma-separated list of the child's streams (`stdout`, `stderr`) that the
 * parent is piping through redaction. The pid lets a process tell whether it is that direct
 * child, since a grandchild's stdout may be a pipe to some other process (`node app | tee log`).
 */
export const PARENT_REDACTED_STREAMS_ENV_VAR = '__VARLOCK_REDACTED_STREAMS';

/** the streams a parent `varlock run` redacts for this process (empty unless we're its direct child) */
export function getParentRedactedStreams(
  env: Record<string, string | undefined>,
  ppid: number | undefined,
): Array<string> {
  const marker = env[PARENT_REDACTED_STREAMS_ENV_VAR];
  if (!marker) return [];
  const separatorIndex = marker.indexOf(':');
  if (separatorIndex === -1 || Number(marker.slice(0, separatorIndex)) !== ppid) return [];
  return marker.slice(separatorIndex + 1).split(',');
}

/** the end of already-written output that could be the start of a sensitive value (usually '') */
export function getPartialValueCarry(written: string): string {
  const length = getRedactionHoldbackLength(written);
  return length ? written.slice(-length) : '';
}

/**
 * Length of a trailing (possibly partial) unmask prefix (`👁 `). Streaming redaction holds it
 * back along with any partial secret, so a revealed value split across writes keeps its marker.
 */
function getUnmaskPrefixHoldbackLength(str: string): number {
  for (let len = Math.min(UNMASK_PREFIX.length, str.length); len > 0; len--) {
    if (str.endsWith(UNMASK_PREFIX.slice(0, len))) return len;
  }
  return 0;
}

/**
 * How much of the end of buffered stream text to hold back before emitting the rest: a
 * trailing partial match of a sensitive value (so a value split across writes is still caught),
 * plus an unmask marker right before it (so a revealed value keeps its marker).
 *
 * The cut never goes through a complete value: a value whose ending is also the start of a
 * value (itself or another, e.g. `secret-token-s`) looks like a partial match at its own end,
 * and cutting there would emit both halves unredacted.
 */
export function getStreamHoldbackLength(str: string): number {
  let boundary = str.length - getRedactionHoldbackLength(str);
  while (boundary < str.length) {
    const crossingEnd = findMatchCrossing(str, boundary);
    if (crossingEnd === undefined) break;
    // keep the complete value whole, then look for a partial match after it
    boundary = str.length - getRedactionHoldbackLength(str.slice(crossingEnd));
  }
  boundary -= getUnmaskPrefixHoldbackLength(str.slice(0, boundary));
  return str.length - boundary;
}

/**
 * Redacts one write to a stream without holding anything back: the write goes out right away,
 * so the stream's own behavior (callbacks, errors, `end()`, ordering) is untouched.
 *
 * `carry` is the end of the previous write that could be the start of a sensitive value. If this
 * write completes one, its part in this write is masked and `splitKey` names the item, since
 * the part already written can't be recalled. Returns the carry for the next write.
 */
export function redactStreamWrite(carry: string, text: string): {
  output: string,
  carry: string,
  splitKey?: string,
} {
  const split = findSplitValueCompletion(carry, text);
  const output = split
    ? SPLIT_VALUE_MASK + redactSensitiveConfigForOutput(text.slice(split.length))
    : redactSensitiveConfigForOutput(text);
  return {
    output,
    carry: getPartialValueCarry(carry + text),
    ...split?.key && { splitKey: split.key },
  };
}

const SPLIT_WARNED_KEY = Symbol.for('varlock.runSplitValueWarned');

function warnSplitValueOnce(key: string) {
  if ((globalThis as any)[SPLIT_WARNED_KEY]) return;
  (globalThis as any)[SPLIT_WARNED_KEY] = true;
  // eslint-disable-next-line no-console
  console.warn([
    `[varlock] the sensitive value of ${key} was split across output chunks with a pause between them,`,
    'so its first part was printed before it could be recognized (the rest was redacted).',
  ].join(' '));
}

/**
 * Creates a writer that pipes a child process output stream through redaction, handling
 * secrets that may be split across chunk boundaries. If a chunk ends with a partial match
 * of a sensitive value, those characters are held back until more data arrives (or a short
 * timeout passes) so the reassembled secret can still be redacted.
 *
 * After a timeout the held text is written as-is: it is only a partial match (maybe just a
 * lookalike), and holding it longer would stall prompts. It is remembered though, so if the
 * rest of a value arrives next (e.g. a child that block-buffers piped output pauses mid-value),
 * that part is masked and a one-time warning names the item.
 */
export function createRedactedStreamWriter(
  stream: { write(str: string): any },
  opts?: { onSplitValue?: (key: string) => void },
) {
  const onSplitValue = opts?.onSplitValue ?? warnSplitValueOnce;
  let pending = '';
  // end of output already flushed (raw, on timeout) that could be the start of a value
  let carry = '';
  let flushTimeout: ReturnType<typeof setTimeout> | undefined;

  const clearFlushTimeout = () => {
    if (flushTimeout !== undefined) {
      clearTimeout(flushTimeout);
      flushTimeout = undefined;
    }
  };

  const flush = () => {
    clearFlushTimeout();
    if (!pending) return;
    carry = getPartialValueCarry(carry + pending);
    stream.write(redactSensitiveConfig(pending));
    pending = '';
  };

  const write = (chunk: Buffer | string) => {
    clearFlushTimeout();
    let text = pending + chunk.toString();
    pending = '';
    let output = '';

    // the rest of a value whose first part was already flushed
    const split = findSplitValueCompletion(carry, text);
    if (split) {
      output = SPLIT_VALUE_MASK;
      text = text.slice(split.length);
      carry = '';
      if (split.key) onSplitValue(split.key);
    }

    // hold back a trailing partial match, including one that started in already-flushed output
    const holdbackLength = getStreamHoldbackLength(carry + text);
    if (holdbackLength > text.length) {
      pending = text;
    } else {
      carry = '';
      pending = holdbackLength ? text.slice(-holdbackLength) : '';
      const emittable = holdbackLength ? text.slice(0, -holdbackLength) : text;
      if (emittable) output += redactSensitiveConfig(emittable);
    }

    if (output) stream.write(output);
    if (pending) {
      flushTimeout = setTimeout(flush, FLUSH_TIMEOUT_MS);
      // don't let a pending flush keep the process alive
      flushTimeout.unref?.();
    }
  };

  return { write, flush };
}
