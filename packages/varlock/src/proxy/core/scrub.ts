import { replaceRealWithPlaceholders } from './substitution';
import type { ProxyManagedItem } from './types';

/** Returns the first managed item whose real value still appears in `text` (a leak), if any. */
export function findRealLeak(text: string, managedItems: Array<ProxyManagedItem>): ProxyManagedItem | undefined {
  return managedItems.find((item) => item.realValue.length > 0 && text.includes(item.realValue));
}

/** Item keys whose real value appears in `text` — i.e. the keys that get scrubbed back to placeholders. */
export function detectScrubbedKeys(text: string, managedItems: Array<ProxyManagedItem>): Array<string> {
  const keys: Array<string> = [];
  for (const item of managedItems) {
    if (item.realValue.length > 0 && text.includes(item.realValue)) keys.push(item.key);
  }
  return keys;
}

/**
 * Length of the longest suffix of `text` that is a strict prefix of some real
 * value — i.e. a partial real value that might complete in the next chunk and
 * so must be held back. Returns 0 (emit everything) when the text doesn't end
 * mid-secret, which keeps streaming responsive instead of buffering a fixed
 * window every chunk.
 */
export function pendingRealPrefixLen(text: string, managedItems: Array<ProxyManagedItem>): number {
  let best = 0;
  for (const item of managedItems) {
    const real = item.realValue;
    if (!real) continue;
    const maxK = Math.min(real.length - 1, text.length);
    for (let k = maxK; k > best; k -= 1) {
      if (text.endsWith(real.slice(0, k))) {
        best = k;
        break;
      }
    }
  }
  return best;
}

/**
 * Scrub real values back to placeholders on an *unbounded text stream* (e.g.
 * SSE), chunk by chunk, so a reflected secret in a streamed response is still
 * replaced without buffering the whole stream. Operates on already-decoded text
 * (the transport wraps it with its own byte decoder — node's StringDecoder or a
 * streaming TextDecoder — so multi-byte UTF-8 chars stay intact across chunks);
 * only a trailing *partial* real value is held back, so complete chunks flow
 * through immediately.
 */
export class StreamingScrubber {
  private carry = '';

  constructor(
    private managedItems: Array<ProxyManagedItem>,
    /** Called with each managed key whose real value is seen in the stream (pre-scrub). */
    private onScrubbedKey?: (key: string) => void,
  ) {}

  private note(text: string) {
    if (this.onScrubbedKey) for (const key of detectScrubbedKeys(text, this.managedItems)) this.onScrubbedKey(key);
  }

  /** Scrub one decoded chunk; returns the text safe to emit now. */
  push(text: string): string {
    const decoded = this.carry + text;
    this.note(decoded);
    const scrubbed = replaceRealWithPlaceholders(decoded, this.managedItems);
    const hold = pendingRealPrefixLen(scrubbed, this.managedItems);
    const emitLen = scrubbed.length - hold;
    this.carry = scrubbed.slice(emitLen);
    return scrubbed.slice(0, emitLen);
  }

  /** Flush any held-back tail (plus a final decoded fragment, if any), fully scrubbed. */
  flush(text = ''): string {
    const decoded = this.carry + text;
    this.carry = '';
    this.note(decoded);
    return replaceRealWithPlaceholders(decoded, this.managedItems);
  }
}
