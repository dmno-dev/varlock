import { getRedactionHoldbackLength, redactSensitiveConfig } from '../env';

/**
 * how long to hold back a possible partial secret before giving up and flushing —
 * chunks split mid-secret (e.g. at pipe buffer boundaries) arrive back-to-back in
 * practice, so this only triggers when output genuinely ends with a secret-prefix lookalike
 */
const FLUSH_TIMEOUT_MS = 100;

/**
 * Creates a writer that pipes a child process output stream through redaction, handling
 * secrets that may be split across chunk boundaries. If a chunk ends with a partial match
 * of a sensitive value, those characters are held back until more data arrives (or a short
 * timeout passes) so the reassembled secret can still be redacted.
 */
export function createRedactedStreamWriter(stream: { write(str: string): any }) {
  let pending = '';
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
    stream.write(redactSensitiveConfig(pending));
    pending = '';
  };

  const write = (chunk: Buffer | string) => {
    clearFlushTimeout();
    pending += chunk.toString();
    const holdbackLength = getRedactionHoldbackLength(pending);
    const emittable = holdbackLength ? pending.slice(0, -holdbackLength) : pending;
    pending = holdbackLength ? pending.slice(-holdbackLength) : '';
    if (emittable) stream.write(redactSensitiveConfig(emittable));
    if (pending) {
      flushTimeout = setTimeout(flush, FLUSH_TIMEOUT_MS);
      // don't let a pending flush keep the process alive
      flushTimeout.unref?.();
    }
  };

  return { write, flush };
}
