import { getRedactionHoldbackLength, redactSensitiveConfig } from '../env';

/**
 * how long to hold back a possible partial secret before giving up and flushing —
 * chunks split mid-secret (e.g. at pipe buffer boundaries) arrive back-to-back in
 * practice, so this only triggers when output genuinely ends with a secret-prefix lookalike
 */
const FLUSH_TIMEOUT_MS = 100;

export type StreamWriteCallback = (err?: Error | null) => void;

/**
 * Creates a writer that pipes a child process output stream through redaction, handling
 * secrets that may be split across chunk boundaries. If a chunk ends with a partial match
 * of a sensitive value, those characters are held back until more data arrives (or a short
 * timeout passes) so the reassembled secret can still be redacted.
 *
 * A callback passed to `write` runs once all of that chunk's text has reached the stream,
 * held back part included, with the first error of the writes that carried it.
 */
export function createRedactedStreamWriter(stream: { write(str: string, callback?: StreamWriteCallback): any }) {
  let pending = '';
  let flushTimeout: ReturnType<typeof setTimeout> | undefined;

  // callbacks still waiting on held back text, each with the positions its chunk spans
  let waiting: Array<{
    start: number, end: number, callback: StreamWriteCallback, error?: Error,
  }> = [];
  let receivedLength = 0;
  let emittedLength = 0;

  const clearFlushTimeout = () => {
    if (flushTimeout !== undefined) {
      clearTimeout(flushTimeout);
      flushTimeout = undefined;
    }
  };

  const emit = (text: string) => {
    emittedLength += text.length;
    const emittedEnd = emittedLength;
    // a chunk can go out over several writes, and an error in any of them is its error
    const carried = waiting.filter((w) => w.start < emittedEnd || w.end <= emittedEnd);
    const redacted = redactSensitiveConfig(text);
    if (!carried.length) return stream.write(redacted);
    waiting = waiting.filter((w) => w.end > emittedEnd);
    return stream.write(redacted, (err) => {
      for (const entry of carried) {
        if (err) entry.error ??= err;
        if (entry.end <= emittedEnd) entry.callback(entry.error ?? err);
      }
    });
  };

  const flush = () => {
    clearFlushTimeout();
    if (!pending) return undefined;
    const text = pending;
    pending = '';
    return emit(text);
  };

  const write = (chunk: Buffer | string, callback?: StreamWriteCallback) => {
    clearFlushTimeout();
    const text = chunk.toString();
    if (callback) waiting.push({ start: receivedLength, end: receivedLength + text.length, callback });
    receivedLength += text.length;
    pending += text;
    const holdbackLength = getRedactionHoldbackLength(pending);
    const emittable = holdbackLength ? pending.slice(0, -holdbackLength) : pending;
    pending = holdbackLength ? pending.slice(-holdbackLength) : '';
    let result: any;
    // an empty write still goes through when a callback is waiting on it
    if (emittable || waiting.some((w) => w.end <= emittedLength)) result = emit(emittable);
    if (pending) {
      flushTimeout = setTimeout(flush, FLUSH_TIMEOUT_MS);
      // don't let a pending flush keep the process alive
      flushTimeout.unref?.();
    }
    return result;
  };

  return { write, flush };
}
