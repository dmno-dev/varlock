import { createHash } from 'node:crypto';

/**
 * Content fingerprint for a file-based env source, recorded into the serialized graph
 * (`SerializedEnvGraph.sources[].contentHash`) at resolution time and re-checked by the
 * automatic injected-env reuse path to detect source file edits since the blob was made.
 *
 * Truncated sha256 - this is drift detection, not an integrity/security boundary, and the
 * blob travels in an env var so we keep it short.
 */
export function hashEnvSourceContents(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex').slice(0, 16);
}
