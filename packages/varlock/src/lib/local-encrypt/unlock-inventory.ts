/**
 * What one unlock covers, gathered before anything asks for it.
 *
 * A grant is opened once and then spent by whatever asks next, so the batch
 * that happens to ask first must not be the only thing the panel describes.
 * Two encrypted values in `.env.local` and a populated value cache are opened
 * by two different callers at two different moments, and whichever got there
 * first used to define the whole panel: the user approved a session on partial
 * information, which is precisely what the panel exists to prevent.
 *
 * This is where the callers meet. Each one declares what it holds as soon as it
 * knows (the env graph at the end of its load, the value cache when it becomes
 * the run's store), and the unlock reads the union. Nothing is delayed waiting
 * for a declaration: a source that has not spoken up yet is simply not listed,
 * because under-promising is the only safe direction on a panel someone is
 * about to approve.
 *
 * Display only, like every other line the daemon draws from a caller: none of
 * it is bound into the crypto, the daemon checks none of it, and being wrong
 * changes nothing but the wording of a row.
 */

import type { UnlockValueSource } from './types';

/** One encrypted value, and the file that defined it */
export type DeclaredEncryptedValue = {
  keyId: string;
  valueName?: string;
  /** the file as the panel should name it, or undefined when it is not known */
  sourceFile?: string;
  /**
   * The value's own ciphertext.
   *
   * The one thing declared here that is not display. It goes to the daemon as
   * a payload, the daemon hashes it, and an item-scoped grant is bound to that
   * digest. Declaring it up front is what makes the narrow choice usable: a
   * grant narrowed to the batch that happened to ask first would refuse every
   * value that rides it afterwards, so the whole run's values are named before
   * anything resolves.
   */
  ciphertext?: string;
};

/** keyId -> (file heading -> the values it defined), in first-seen order */
const declaredFiles = new Map<string, Map<string, UnlockValueSource>>();
/** keyId -> what the value cache on that key holds */
const declaredCaches = new Map<string, UnlockValueSource>();
/**
 * keyId -> the ciphertexts a grant on that key will be asked to open.
 *
 * Files only. The value cache is deliberately absent: it is never item scoped
 * (its entries are machine-written and rewritten constantly, so narrowing to
 * them would prompt on every provider refresh), and the daemon covers it by
 * reading its own cache file rather than by anything sent from here.
 */
const declaredCiphertexts = new Map<string, Set<string>>();

/**
 * Declare the encrypted values a graph load found, replacing whatever the last
 * load declared.
 *
 * Replacing rather than accumulating is what keeps a long-lived process (a dev
 * server reloading its env) honest: a value that has since been deleted must
 * stop being listed as something the next unlock hands over.
 */
export function declareEncryptedFileValues(values: Array<DeclaredEncryptedValue>) {
  declaredFiles.clear();
  declaredCiphertexts.clear();
  for (const {
    keyId, valueName, sourceFile, ciphertext,
  } of values) {
    if (!keyId || !valueName) continue;
    if (ciphertext) {
      let items = declaredCiphertexts.get(keyId);
      if (!items) {
        items = new Set();
        declaredCiphertexts.set(keyId, items);
      }
      items.add(ciphertext);
    }
    let byFile = declaredFiles.get(keyId);
    if (!byFile) {
      byFile = new Map();
      declaredFiles.set(keyId, byFile);
    }
    // Values whose file is unknown are grouped together and listed under no
    // heading, the same way a batch lists them.
    const groupKey = sourceFile ?? '';
    let source = byFile.get(groupKey);
    if (!source) {
      source = { kind: 'file', path: sourceFile, entries: [] };
      byFile.set(groupKey, source);
    }
    if (!source.entries!.some((entry) => entry.name === valueName)) {
      source.entries!.push({ name: valueName });
    }
  }
}

/**
 * Declare what the value cache on a key holds, or drop it with no source.
 *
 * Dropping matters as much as declaring: a run whose cache is disabled or
 * memory-backed must not inherit a line from the run before it, since that
 * grant will never open a cache file.
 */
export function declareCacheInventory(keyId: string, source?: UnlockValueSource) {
  if (!source) declaredCaches.delete(keyId);
  else declaredCaches.set(keyId, source);
}

/** Forget every cache declaration, so a run can declare only the store it uses */
export function clearDeclaredCacheInventories() {
  declaredCaches.clear();
}

/**
 * Everything declared for one key, files first and the cache last.
 *
 * The order is fixed here rather than left to whoever declared first, so the
 * panel reads the same way whichever source triggers the unlock.
 */
export function unlockInventoryForKey(keyId: string): Array<UnlockValueSource> {
  const sources = [...(declaredFiles.get(keyId)?.values() ?? [])];
  const cache = declaredCaches.get(keyId);
  if (cache) sources.push(cache);
  return sources;
}

/**
 * The ciphertexts a grant on this key will be asked to open, so far.
 *
 * What an item-scoped approval would be bound to, once the daemon has hashed
 * them. Empty when nothing declared itself, and the panel then offers no narrow
 * choice rather than one that would open nothing.
 */
export function unlockItemsForKey(keyId: string): Array<string> {
  return [...(declaredCiphertexts.get(keyId) ?? [])];
}

/** Forget everything declared (used by tests and the lock flows) */
export function clearUnlockInventory() {
  declaredFiles.clear();
  declaredCaches.clear();
  declaredCiphertexts.clear();
}
