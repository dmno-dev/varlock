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
};

/** keyId -> (file heading -> the values it defined), in first-seen order */
const declaredFiles = new Map<string, Map<string, UnlockValueSource>>();
/** keyId -> what the value cache on that key holds */
const declaredCaches = new Map<string, UnlockValueSource>();

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
  for (const { keyId, valueName, sourceFile } of values) {
    if (!keyId || !valueName) continue;
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

/** Forget everything declared (used by tests and the lock flows) */
export function clearUnlockInventory() {
  declaredFiles.clear();
  declaredCaches.clear();
}
