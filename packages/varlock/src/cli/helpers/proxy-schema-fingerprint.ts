import { createHash } from 'node:crypto';

import {
  ParsedEnvSpecArrayLiteral,
  ParsedEnvSpecFunctionArgs,
  ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecObjectLiteral,
  ParsedEnvSpecStaticValue,
} from '@env-spec/parser';

import type { EnvGraph } from '../../env-graph';
import { CliExitError } from './exit-error';
import { getActiveProxySession } from '../../proxy/session-registry';
import {
  PROXY_CHILD_ENV_VAR,
  PROXY_SCHEMA_FINGERPRINT_ENV_VAR,
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
  if (node instanceof ParsedEnvSpecArrayLiteral) {
    // A single-element array is treated as identical to the bare value, so e.g.
    // `domain=a` and `domain=[a]` (semantically equal) fingerprint the same.
    if (node.values.length === 1) return canonicalParsed(node.values[0]);
    // Otherwise array order is significant (e.g. domain/method lists) — keep it.
    return `[${node.values.map((v) => canonicalParsed(v)).join(',')}]`;
  }
  if (node instanceof ParsedEnvSpecObjectLiteral) {
    const entries = node.values.map((kv) => `${kv.key}=${canonicalParsed(kv.value)}`);
    entries.sort();
    return `{${entries.join(',')}}`;
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
 *
 * Detection goes through the shared `getActiveProxySession` resolver (env marker
 * → session token → process ancestry), so clearing `__VARLOCK_PROXY_CHILD` alone
 * does not bypass the guard — the session token and ancestry still resolve the
 * session whose fingerprint we enforce against.
 */
export async function enforceProxySchemaFingerprint(
  envGraph: EnvGraph,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const session = await getActiveProxySession(env).catch(() => undefined);

  // Prefer the resolved session's fingerprint as source of truth; fall back to
  // the env-exported fingerprint only when we know we're in a proxy child (marker
  // present) but the registry couldn't be read.
  let expected = session?.schemaFingerprint;
  if (!expected && env[PROXY_CHILD_ENV_VAR] === '1') {
    expected = env[PROXY_SCHEMA_FINGERPRINT_ENV_VAR];
  }
  if (!expected) return;

  const actual = buildProxySchemaFingerprint(envGraph);
  if (actual === expected) return;

  throw new CliExitError('Schema changed inside an active proxy session.', {
    details: 'The resolved .env.schema no longer matches the fingerprint captured when the proxy session started. This guards against editing the schema mid-session (e.g. downgrading @sensitive, or adding a new item that resolves a secret) to recover real values.',
    suggestion: 'Restart the proxy from a trusted (non-proxied) context to pick up the change. (If it was started with `varlock proxy start --allow-reload`, run `varlock proxy refresh` from a trusted context instead.)',
    forceExit: true,
  });
}
