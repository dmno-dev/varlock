import _ from '@env-spec/utils/my-dash';
import type { SerializedEnvGraph } from '../env-graph';

/**
 * The magic internal host the proxy runtime answers itself (never forwarded
 * upstream). Rides the data plane: the proxy port is the one channel that must
 * exist wherever proxied work happens (attach today; sandboxed and remote
 * workloads later).
 */
export const VARLOCK_INTERNAL_HOST = 'varlock.internal';
export const SESSION_ENV_ENDPOINT_PATH = '/session-env';
/** Session token header for internal endpoint requests (lowercase: node lowercases incoming header names). */
export const PROXY_TOKEN_HEADER = 'x-varlock-proxy-token';

/**
 * The complete child view a proxy session hands to whatever spawns a proxied
 * child: the env the child should see (placeholders for sensitive items, real
 * values for non-secrets and `@proxy=passthrough`), the keys withheld entirely,
 * and the child-view serialized graph (for the `__VARLOCK_ENV` blob and stdout
 * redaction). Never contains wire-injection real values; those stay in the
 * session owner's memory and only ever touch the network boundary.
 *
 * One producer (`buildSessionEnvPayload`, session-owner side) and one consumer
 * (`spawnProxiedChild`). A one-shot `proxy run` builds it in-process; an
 * attaching `proxy run` fetches it from the owner via the `varlock.internal`
 * endpoint. Attach ADOPTS this env verbatim: the owner resolved it in its own
 * context (its shell overrides, its env selection), and attaching means running
 * inside THAT session's env, not re-resolving in the attaching shell's context.
 */
export type SessionEnvPayload = {
  env: Record<string, string>;
  omittedKeys: Array<string>;
  serializedGraph: SerializedEnvGraph;
};

/** Build the payload from a prepared proxy policy (the child-view env/graph it already computed). */
export function buildSessionEnvPayload(policy: {
  resolvedEnv: Record<string, string>;
  omittedKeys: Array<string>;
  serializedGraph: SerializedEnvGraph;
}): SessionEnvPayload {
  return {
    env: policy.resolvedEnv,
    omittedKeys: policy.omittedKeys,
    serializedGraph: policy.serializedGraph,
  };
}

export function encodeSessionEnvPayload(payload: SessionEnvPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parse + shape-check a payload. The one-shot path round-trips through
 * encode/decode too, so every ordinary `proxy run` exercises the exact wire
 * encoding: a non-JSON-safe value fails loudly in the common path instead of
 * rotting in the rarely-exercised attach path.
 */
export function decodeSessionEnvPayload(raw: string): SessionEnvPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('session env payload is not valid JSON');
  }
  if (!_.isPlainObject(parsed)) throw new Error('session env payload is not an object');
  const candidate = parsed as Record<string, unknown>;

  if (!_.isPlainObject(candidate.env)) throw new Error('session env payload `env` is not an object');
  for (const [key, value] of Object.entries(candidate.env as Record<string, unknown>)) {
    if (!_.isString(value)) throw new Error(`session env payload \`env.${key}\` is not a string`);
  }

  if (!Array.isArray(candidate.omittedKeys) || candidate.omittedKeys.some((k) => !_.isString(k))) {
    throw new Error('session env payload `omittedKeys` is not an array of strings');
  }

  if (!_.isPlainObject(candidate.serializedGraph)
    || !_.isPlainObject((candidate.serializedGraph as Record<string, unknown>).config)) {
    throw new Error('session env payload `serializedGraph` is missing or malformed');
  }

  return {
    env: candidate.env as Record<string, string>,
    omittedKeys: candidate.omittedKeys as Array<string>,
    serializedGraph: candidate.serializedGraph as SerializedEnvGraph,
  };
}
