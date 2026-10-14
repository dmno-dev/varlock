import { buildEnvBlobBindings, type EnvBlobBindings } from 'varlock/env-blob';

/** Cloudflare caps each Worker secret at 5KB, so a large `__VARLOCK_ENV` blob has to be split. */
export const CF_SECRET_MAX_BYTES = 5120;

export type VarlockEnvBlobBindings = EnvBlobBindings;

/**
 * Build the Worker secret bindings that carry varlock's resolved-env blob to
 * `@varlock/cloudflare-integration/init`: `__VARLOCK_ENV`, split into `__VARLOCK_ENV_CHUNKS` +
 * `__VARLOCK_ENV_<n>` past Cloudflare's 5KB secret limit, plus `_VARLOCK_ENV_KEY` when encrypted.
 * Every value must be uploaded as a secret (`secret_text`).
 *
 * Thin Cloudflare-sized wrapper over `buildEnvBlobBindings` from `varlock/env-blob`, the shared
 * format used by `varlock-wrangler`, the Vite plugin, and non-wrangler deploy tools.
 */
export function buildVarlockEnvBlobBindings(opts: {
  /** compact JSON of the serialized env graph (`varlock load --format json-full --compact`) */
  json: string;
  /** graph `settings.encryptInjectedEnv` */
  encryptInjectedEnv?: boolean;
  /** hex key to encrypt with; defaults to the ambient `_VARLOCK_ENV_KEY`, generated when required */
  encryptionKey?: string;
}): VarlockEnvBlobBindings {
  return buildEnvBlobBindings({ ...opts, maxBytes: CF_SECRET_MAX_BYTES });
}
