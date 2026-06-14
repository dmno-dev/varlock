import { createHash } from 'node:crypto';

import {
  ParsedEnvSpecFunctionArgs,
  ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecStaticValue,
} from '@env-spec/parser';

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
 * Canonical, pre-resolution string for a parsed value/arg node. Hashes the
 * *definition* (resolver expression, decorator args), never the resolved value —
 * so no secrets, no I/O, deterministic. Named args are sorted so authoring order
 * doesn't matter; positional args (e.g. `$REF`s) keep order.
 */
function canonicalParsed(node: unknown): string {
  if (node === undefined || node === null) return '∅';
  if (node instanceof ParsedEnvSpecStaticValue) return JSON.stringify(node.value ?? null);
  if (node instanceof ParsedEnvSpecKeyValuePair) return `${node.key}=${canonicalParsed(node.value)}`;
  if (node instanceof ParsedEnvSpecFunctionCall) return `${node.name}${canonicalParsed(node.data.args)}`;
  if (node instanceof ParsedEnvSpecFunctionArgs) {
    const positional: Array<string> = [];
    const named: Array<string> = [];
    for (const val of node.values) {
      if (val instanceof ParsedEnvSpecKeyValuePair) named.push(`${val.key}=${canonicalParsed(val.value)}`);
      else positional.push(canonicalParsed(val));
    }
    named.sort();
    return `(${[...positional, ...named].join(',')})`;
  }
  return '?';
}

function canonicalDecorator(dec: { name: string; parsedDecorator: { value?: unknown } }): string {
  return `@${dec.name}=${canonicalParsed(dec.parsedDecorator.value)}`;
}

/**
 * Build a deterministic fingerprint of the schema *definition*: per config key,
 * the value-source definitions (pre-resolution) plus every non-`inert`
 * decorator, plus all non-`inert` root decorators (egress, detached `@proxy`,
 * `@defaultSensitive`, …). Captures everything behavioral — proxy rules,
 * sensitivity, types, placeholders, value sources — while ignoring cosmetic
 * decorators (`@example`, `@docs`, `@icon`, …) and formatting.
 *
 * Intentionally location-independent (no basePath, only parsed expressions): a
 * nested/attached command resolving the schema from a different cwd must produce
 * the same fingerprint as the session that started the proxy.
 */
export function buildProxySchemaFingerprint(envGraph: EnvGraph): string {
  const rootDecorators = envGraph.sortedDataSources
    .flatMap((source) => source.rootDecorators)
    .filter((dec) => !dec.isInert)
    .map((dec) => canonicalDecorator(dec))
    .sort();

  const items = envGraph.sortedConfigKeys.map((key) => {
    const item = envGraph.configSchema[key];
    const valueDefs = item.defs.map((def) => canonicalParsed(def.itemDef.parsedValue));
    const decorators = item.allDecorators
      .filter((dec) => !dec.isInert)
      .map((dec) => canonicalDecorator(dec))
      .sort();
    return { key, valueDefs, decorators };
  });

  const input = JSON.stringify({ rootDecorators, items });

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
