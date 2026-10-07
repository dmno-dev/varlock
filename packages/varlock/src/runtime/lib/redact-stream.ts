import {
  findSplitValueCompletion, getPartialValueCarry, getStreamHoldbackLength, redactSensitiveConfig, SPLIT_VALUE_MASK,
} from '../env';

/**
 * how long to hold back a possible partial secret before giving up and flushing —
 * chunks split mid-secret (e.g. at pipe buffer boundaries) arrive back-to-back in
 * practice, so this only triggers when output genuinely ends with a secret-prefix lookalike
 */
export const FLUSH_TIMEOUT_MS = 100;

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
