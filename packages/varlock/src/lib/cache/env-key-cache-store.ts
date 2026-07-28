import { createHash } from 'node:crypto';
import { CacheStore } from './cache-store';
import { encryptEnvBlobSync, decryptEnvBlobSync } from '../../runtime/crypto';

/**
 * Env var that can supply a 256-bit hex encryption key for disk caching
 * (same format as `_VARLOCK_ENV_KEY`; generate one with `varlock generate-key`).
 *
 * This is deliberately a separate var from `_VARLOCK_ENV_KEY` — that one is
 * auto-generated (ephemeral) in some flows, which would silently defeat
 * caching. Set this one explicitly (e.g. as a CI secret) to enable disk
 * caching without the key ever touching disk.
 */
export const CACHE_ENV_KEY_VAR = '_VARLOCK_CACHE_KEY';

export function getCacheEnvKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return env[CACHE_ENV_KEY_VAR] || undefined;
}

/**
 * Create a disk cache store encrypted with an env-provided AES-256-GCM key
 * instead of the local-encrypt backend.
 *
 * Each distinct key gets its own cache file (named by key fingerprint), so
 * rotating the key naturally invalidates the old cache.
 *
 * Throws immediately if the key is not a valid 64-char hex string.
 */
export function createEnvKeyCacheStore(hexKey: string): CacheStore {
  // validate the key shape up front (throws on bad keys) by round-tripping a probe
  decryptEnvBlobSync(encryptEnvBlobSync('probe', hexKey), hexKey);

  const fingerprint = createHash('sha256').update(hexKey).digest('hex').slice(0, 12);
  return new CacheStore(`env-key-${fingerprint}`, {
    ensureReady: () => {
      // key already validated above — nothing to provision
    },
    encrypt: (plaintext) => encryptEnvBlobSync(plaintext, hexKey),
    decrypt: (ciphertext) => decryptEnvBlobSync(ciphertext, hexKey),
  });
}
