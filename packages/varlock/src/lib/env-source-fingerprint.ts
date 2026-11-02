import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SerializedEnvGraph } from '../env-graph/lib/env-graph';

/**
 * Content fingerprint for a file-based env source, recorded into the serialized graph
 * (`SerializedEnvGraph.sources[].contentHash`) at resolution time and re-checked by
 * {@link checkEnvSourceDrift} to detect source file edits since the graph was made.
 *
 * Truncated sha256 - this is drift detection, not an integrity/security boundary, and the
 * blob travels in an env var so we keep it short.
 */
export function hashEnvSourceContents(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex').slice(0, 16);
}

export type EnvSourceDrift = { drifted: false } | { drifted: true, reason: string };

export interface CheckEnvSourceDriftOptions {
  /**
   * How to treat a source that is not a regular file (e.g. 1Password Environments serves
   * `.env` as a FIFO). Its contents can't be verified without reading it, and reading has
   * side effects (the serving process rewrites it) or blocks forever on a writerless pipe.
   * - `drift` (default): report drift, so the caller re-resolves (which reads it normally)
   * - `assume-unchanged`: skip it, for callers that only care about local file edits
   */
  nonRegularFiles?: 'drift' | 'assume-unchanged';
}

/**
 * Whether a fresh load would differ from `graph` because of env files on disk: a recorded
 * source was edited, removed, or replaced, or a file the load looked for and did not find
 * (an auto-load candidate like `.env.local`, an `allowMissing` import) now exists.
 *
 * Reads and hashes each recorded file source - no parsing or resolution - so it is cheap
 * enough to run before deciding whether to re-resolve. Disabled sources are verified too:
 * `@disable` lives in the source's own content, so an edit can re-enable it (an edit that
 * leaves it disabled just costs one harmless re-resolution).
 *
 * Values that change without a file edit (a resolver reading a remote vault, `exec()`)
 * are out of scope: only a re-resolution sees those.
 */
export function checkEnvSourceDrift(
  graph: Pick<SerializedEnvGraph, 'basePath' | 'sources' | 'absentSourcePaths'>,
  opts?: CheckEnvSourceDriftOptions,
): EnvSourceDrift {
  if (!Array.isArray(graph.sources)) {
    return { drifted: true, reason: 'no sources recorded' };
  }
  const basePath = graph.basePath ?? '';
  for (const source of graph.sources) {
    if (source.path === undefined) continue;
    // older producers didn't record fingerprints - we can't verify, so treat as drift
    if (!source.contentHash) {
      return { drifted: true, reason: `no content fingerprint for source ${source.path}` };
    }
    const sourceFullPath = path.resolve(basePath, source.path);
    let currentContents: string;
    try {
      // stat-gate before reading (see `nonRegularFiles`)
      if (!fs.statSync(sourceFullPath).isFile()) {
        if (opts?.nonRegularFiles === 'assume-unchanged') continue;
        return { drifted: true, reason: `source ${source.path} is not a regular file` };
      }
      currentContents = fs.readFileSync(sourceFullPath, 'utf8');
    } catch {
      return { drifted: true, reason: `source file ${source.path} is missing or unreadable` };
    }
    if (hashEnvSourceContents(currentContents) !== source.contentHash) {
      return { drifted: true, reason: `source file ${source.path} changed since it was loaded` };
    }
  }
  // older producers didn't record these - only the recorded sources can be checked
  for (const absentPath of graph.absentSourcePaths ?? []) {
    if (fs.existsSync(path.resolve(basePath, absentPath))) {
      return { drifted: true, reason: `env file ${absentPath} was created since the env was loaded` };
    }
  }
  return { drifted: false };
}
