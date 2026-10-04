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
 * held back part included.
 */
export function createRedactedStreamWriter(stream: { write(str: string, callback?: StreamWriteCallback): any }) {
  let pending = '';
  let flushTimeout: ReturnType<typeof setTimeout> | undefined;

  // callbacks still waiting on held back text, each with the position its chunk ends at
  let waiting: Array<{ end: number, callback: StreamWriteCallback }> = [];
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
    const completed = waiting.filter((w) => w.end <= emittedLength);
    const redacted = redactSensitiveConfig(text);
    if (!completed.length) return stream.write(redacted);
    waiting = waiting.filter((w) => w.end > emittedLength);
    return stream.write(redacted, (err) => {
      for (const { callback } of completed) callback(err);
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
    receivedLength += text.length;
    if (callback) waiting.push({ end: receivedLength, callback });
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
