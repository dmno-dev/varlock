import { statSync } from 'node:fs';

/** Returns file mtime in ms, or undefined if the path cannot be statted. */
export function getFileMtimeMs(filePath: string): number | undefined {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * True when a watch event should be ignored because the file's mtime did not
 * change. macOS (and some editors/agents) emit fs.watch events when a file is
 * merely opened or inspected without rewriting it.
 *
 * If either mtime is unknown, do not ignore — safer to reload than to miss a
 * real change (e.g. file was deleted then recreated).
 */
export function shouldIgnoreUnchangedMtime(
  previousMtimeMs: number | undefined,
  nextMtimeMs: number | undefined,
): boolean {
  return previousMtimeMs !== undefined
    && nextMtimeMs !== undefined
    && previousMtimeMs === nextMtimeMs;
}
