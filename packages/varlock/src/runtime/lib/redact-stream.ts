import { getRedactionHoldbackLength, redactSensitiveConfigForLogs } from '../env';

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
    stream.write(redactSensitiveConfigForLogs(pending));
    pending = '';
  };

  const write = (chunk: Buffer | string) => {
    clearFlushTimeout();
    pending += chunk.toString();
    const holdbackLength = getRedactionHoldbackLength(pending);
    const emittable = holdbackLength ? pending.slice(0, -holdbackLength) : pending;
    pending = holdbackLength ? pending.slice(-holdbackLength) : '';
    if (emittable) stream.write(redactSensitiveConfigForLogs(emittable));
    if (pending) {
      flushTimeout = setTimeout(flush, FLUSH_TIMEOUT_MS);
      // don't let a pending flush keep the process alive
      flushTimeout.unref?.();
    }
  };

  return { write, flush };
}
