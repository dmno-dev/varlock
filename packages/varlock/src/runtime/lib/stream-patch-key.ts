/**
 * Marks a stream whose `write` varlock has patched to redact sensitive values (holds its patch
 * state). A global symbol so every module instance sees it, and kept in its own module so the
 * console patch can check it without importing the node-only stream patching code.
 */
export const STREAM_PATCH_STATE_KEY = Symbol.for('varlock.streamRedaction');

export function isStreamRedactionPatched(stream: unknown): boolean {
  return !!stream && !!(stream as any)[STREAM_PATCH_STATE_KEY];
}
