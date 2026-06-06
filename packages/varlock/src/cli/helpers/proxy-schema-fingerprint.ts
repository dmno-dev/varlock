import { createHash } from 'node:crypto';

import type { EnvGraph } from '../../env-graph';

/**
 * Build a deterministic fingerprint for schema-level safety controls.
 * Phase 1 focuses on preventing sensitivity downgrades from taking effect
 * mid-proxy-run, so we hash item keys + sensitivity/required/type metadata.
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

  const input = JSON.stringify({
    basePath: envGraph.basePath ?? null,
    schemaShape,
  });

  return createHash('sha256').update(input).digest('hex');
}
