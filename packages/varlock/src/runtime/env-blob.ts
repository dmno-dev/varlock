import {
  decryptEnvBlobSync, encryptEnvBlobSync, generateEncryptionKeyHex, isEncryptedBlob,
} from './crypto';

/**
 * The env vars that carry varlock's serialized env graph (the "blob") to a runtime.
 *
 * Small blobs travel as a single `__VARLOCK_ENV`. Platforms that cap the size of one env var or
 * secret (Cloudflare Workers: 5KB) get the blob split into `__VARLOCK_ENV_CHUNKS` (the count) plus
 * `__VARLOCK_ENV_0`, `__VARLOCK_ENV_1`, ... which the runtime reassembles. `_VARLOCK_ENV_KEY` is
 * present when the blob is encrypted (`@encryptInjectedEnv`, or an ambient key).
 */
export type EnvBlobBindings = {
  __VARLOCK_ENV?: string;
  __VARLOCK_ENV_CHUNKS?: string;
  _VARLOCK_ENV_KEY?: string;
} & Record<`__VARLOCK_ENV_${number}`, string>;

/**
 * Split a string into chunks where each chunk's UTF-8 byte length is at most `maxBytes`.
 * Unlike slicing a Buffer, this never splits a multi-byte character.
 */
export function chunkString(str: string, maxBytes: number): Array<string> {
  const chunks: Array<string> = [];
  let current = '';
  let currentBytes = 0;
  for (const char of str) {
    const charBytes = new TextEncoder().encode(char).byteLength;
    if (currentBytes + charBytes > maxBytes && current) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Build the env vars / secret bindings that deliver a serialized env graph to a runtime.
 * Used by `varlock-wrangler`, the Cloudflare Vite plugin, and deploy-tool integrations
 * (Alchemy) so the wire format lives in one place, next to {@link readEnvBlob} which parses it.
 *
 * Every returned value must be treated as a secret by the target platform: the blob contains
 * sensitive values, and the key decrypts it.
 */
export function buildEnvBlobBindings(opts: {
  /** compact JSON of the serialized env graph (`varlock load --format json-full --compact`) */
  json: string;
  /** graph `settings.encryptInjectedEnv`: encrypt the blob, generating a key when none is given */
  encryptInjectedEnv?: boolean;
  /**
   * hex key to encrypt with. Defaults to the ambient `_VARLOCK_ENV_KEY`; when encryption is
   * required and no key is available, a fresh one is generated and returned alongside the blob.
   */
  encryptionKey?: string;
  /**
   * per-variable byte limit of the target platform (Cloudflare Workers secrets: 5120). When set
   * and the blob is larger, it is split into `__VARLOCK_ENV_CHUNKS` + `__VARLOCK_ENV_<n>`.
   * Leave unset for platforms without a per-variable cap.
   */
  maxBytes?: number;
}): EnvBlobBindings {
  const bindings: Record<string, string> = {};
  let encryptionKey = opts.encryptionKey ?? process.env._VARLOCK_ENV_KEY;
  if (opts.encryptInjectedEnv && !encryptionKey) encryptionKey = generateEncryptionKeyHex();

  let blob = opts.json;
  if (encryptionKey) {
    blob = encryptEnvBlobSync(blob, encryptionKey);
    bindings._VARLOCK_ENV_KEY = encryptionKey;
  }

  if (opts.maxBytes === undefined || new TextEncoder().encode(blob).byteLength <= opts.maxBytes) {
    bindings.__VARLOCK_ENV = blob;
  } else {
    const chunks = chunkString(blob, opts.maxBytes);
    bindings.__VARLOCK_ENV_CHUNKS = String(chunks.length);
    chunks.forEach((chunk, i) => {
      bindings[`__VARLOCK_ENV_${i}`] = chunk;
    });
  }
  return bindings as EnvBlobBindings;
}

/**
 * Read the serialized env graph JSON back out of an env / bindings object produced by
 * {@link buildEnvBlobBindings}: reassembles chunks and decrypts when `_VARLOCK_ENV_KEY` is present.
 * Returns `undefined` when no blob is present.
 */
export function readEnvBlob(env: Record<string, unknown>): string | undefined {
  let blob: string | undefined;
  if (typeof env.__VARLOCK_ENV === 'string' && env.__VARLOCK_ENV) {
    blob = env.__VARLOCK_ENV;
  } else if (env.__VARLOCK_ENV_CHUNKS !== undefined) {
    const chunkCount = parseInt(String(env.__VARLOCK_ENV_CHUNKS), 10);
    if (!Number.isFinite(chunkCount) || chunkCount < 1 || chunkCount > 1000) {
      throw new Error(`[varlock] invalid __VARLOCK_ENV_CHUNKS value: ${String(env.__VARLOCK_ENV_CHUNKS)}`);
    }
    const parts: Array<string> = [];
    for (let i = 0; i < chunkCount; i++) {
      const chunk = env[`__VARLOCK_ENV_${i}`];
      if (typeof chunk !== 'string') {
        throw new Error(`[varlock] missing chunk __VARLOCK_ENV_${i} (expected ${chunkCount} chunks)`);
      }
      parts.push(chunk);
    }
    blob = parts.join('');
  }
  if (blob === undefined) return undefined;
  if (isEncryptedBlob(blob)) {
    const key = env._VARLOCK_ENV_KEY;
    if (typeof key !== 'string' || !key) {
      throw new Error('[varlock] __VARLOCK_ENV is encrypted but _VARLOCK_ENV_KEY is not set');
    }
    return decryptEnvBlobSync(blob, key);
  }
  return blob;
}
