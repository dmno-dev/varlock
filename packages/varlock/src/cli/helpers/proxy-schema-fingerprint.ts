import { createHash } from 'node:crypto';

import type { EnvGraph } from '../../env-graph';
import { CliExitError } from './exit-error';
import { getProxySessionByToken } from '../../proxy/session-registry';
import {
  PROXY_CHILD_ENV_VAR,
  PROXY_SCHEMA_FINGERPRINT_ENV_VAR,
  PROXY_SESSION_ID_ENV_VAR,
  PROXY_SESSION_UUID_ENV_VAR,
} from '../../proxy/env-vars';

/**
 * Build a deterministic fingerprint for schema-level safety controls.
 * Phase 1 focuses on preventing sensitivity downgrades from taking effect
 * mid-proxy-run, so we hash item keys + sensitivity/required/type metadata.
 *
 * Intentionally location-independent (no basePath): the security-relevant
 * invariant is the schema *shape*, and including the base path would cause
 * false-positive mismatches when a nested command resolves the schema from a
 * different working directory than the session was started in.
 */
export function buildProxySchemaFingerprint(envGraph: EnvGraph): string {
  const schemaShape = envGraph.sortedConfigKeys.map((key) => {
    const item = envGraph.configSchema[key];
    return {
      key,
      isSensitive: item.isSensitive,
      isRequired: item.isRequired,
      dataType: item.dataType?.name ?? null,
    };
  });

  const input = JSON.stringify({ schemaShape });

  return createHash('sha256').update(input).digest('hex');
}

/**
 * When a command runs inside an active `varlock proxy run` child, re-derive the
 * schema fingerprint and refuse if it no longer matches the one captured when
 * the session started. Closes the "edit .env.schema, flip @sensitive off,
 * re-load to recover raw values" downgrade — a deliberate schema change must be
 * re-approved out-of-band via `varlock proxy refresh`.
 *
 * No-ops outside a proxied context, and when there's no stored fingerprint to
 * compare against (fails open rather than blocking unrelated commands).
 */
export async function enforceProxySchemaFingerprint(
  envGraph: EnvGraph,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env[PROXY_CHILD_ENV_VAR] !== '1') return;

  // Prefer the session record as source of truth; fall back to the
  // env-exported fingerprint if the registry can't be read.
  const sessionToken = env[PROXY_SESSION_ID_ENV_VAR] ?? env[PROXY_SESSION_UUID_ENV_VAR];
  let expected: string | undefined;
  if (sessionToken) {
    const session = await getProxySessionByToken(sessionToken).catch(() => undefined);
    expected = session?.schemaFingerprint;
  }
  expected ??= env[PROXY_SCHEMA_FINGERPRINT_ENV_VAR];
  if (!expected) return;

  const actual = buildProxySchemaFingerprint(envGraph);
  if (actual === expected) return;

  throw new CliExitError('Schema changed inside an active proxy session.', {
    details: 'The resolved .env.schema shape no longer matches the fingerprint captured when the proxy session started. This guards against downgrading @sensitive items mid-session to recover real values.',
    suggestion: 'Re-approve the change by running `varlock proxy refresh` from a trusted (non-proxied) context, then retry.',
    forceExit: true,
  });
}
