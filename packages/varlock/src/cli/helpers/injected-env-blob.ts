import { encryptEnvBlobSync, generateEncryptionKeyHex } from '../../runtime/crypto';

/**
 * Build the `__VARLOCK_ENV` (+ `_VARLOCK_ENV_KEY`) entries for a spawned child.
 * Shared by `varlock run` and `varlock proxy run` so blob behavior can't diverge.
 *
 * Honors `@encryptInjectedEnv` in blob-only mode: the blob is encrypted with an
 * ephemeral key that rides alongside it in the child env (the runtime decrypts
 * transparently via isEncryptedBlob). Key + ciphertext co-located means this is
 * LEAK resistance (crash reporters, env dumps, logs), not attacker resistance —
 * same trust framing as the auto-load path. In `all` mode the values are already
 * plaintext env vars, so encrypting the blob would protect nothing; it stays
 * plaintext there. An ambient `_VARLOCK_ENV_KEY` is reused (nested runs keep one
 * key) or forwarded even without encryption, matching prior behavior for
 * build-time-encrypted contexts.
 */
export function buildInjectedBlobEnv(opts: {
  serializedGraph: { settings?: { encryptInjectedEnv?: boolean } };
  injectVars: boolean;
  injectBlob: boolean;
  ambientEnvKey?: string;
}): { __VARLOCK_ENV?: string; _VARLOCK_ENV_KEY?: string } {
  if (!opts.injectBlob) return {};

  const json = JSON.stringify(opts.serializedGraph);
  if (opts.injectVars) return { __VARLOCK_ENV: json };

  if (opts.serializedGraph.settings?.encryptInjectedEnv) {
    const key = opts.ambientEnvKey ?? generateEncryptionKeyHex();
    return { __VARLOCK_ENV: encryptEnvBlobSync(json, key), _VARLOCK_ENV_KEY: key };
  }

  return {
    __VARLOCK_ENV: json,
    ...(opts.ambientEnvKey ? { _VARLOCK_ENV_KEY: opts.ambientEnvKey } : {}),
  };
}
