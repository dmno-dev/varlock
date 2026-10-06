// Tracks items currently mid-resolution across all in-flight `resolveEnvValues()` calls.
// Kept in its own dependency-free module so the CLI entry can read it without loading the
// whole env graph.
const inProgressItemKeys = new Set<string>();

export function markItemResolutionStarted(key: string) {
  inProgressItemKeys.add(key);
}
export function markItemResolutionFinished(key: string) {
  inProgressItemKeys.delete(key);
}

/** Keys of items whose resolver was started but has not settled yet */
export function getInProgressResolutionKeys(): Array<string> {
  return [...inProgressItemKeys];
}
