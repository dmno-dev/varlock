/**
 * Which env vars were genuine user overrides (present in the caller's env AND
 * defined in the schema) at the original varlock invocation. Carried in the
 * injected `__VARLOCK_ENV` blob as a plain `overrideKeys` field so nested
 * varlock invocations re-apply exactly those as overrides, and nothing else:
 * parent-injected values must not shadow fresh resolution.
 *
 * Plain field + ignore-unknown is the blob's compatibility model (the graph
 * itself carries no version field). Older producers wrapped the same list in a
 * `__varlockOverrideMeta` / `__varlockRunMeta` object; we still read the array
 * out of those, without the source/version ceremony.
 */

export function normalizeOverrideKeys(overrideKeys: Array<string>): Array<string> {
  return [...new Set(overrideKeys.filter((k) => typeof k === 'string'))];
}

/** Extract the override-keys list from an injected `__VARLOCK_ENV` blob, if present. */
export function parseBlobOverrideKeys(blob?: string): Array<string> | undefined {
  if (!blob) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const graph = parsed as {
    overrideKeys?: unknown;
    __varlockOverrideMeta?: { overrideKeys?: unknown };
    __varlockRunMeta?: { overrideKeys?: unknown };
  };
  const keys = graph.overrideKeys
    ?? graph.__varlockOverrideMeta?.overrideKeys
    ?? graph.__varlockRunMeta?.overrideKeys;
  if (!Array.isArray(keys)) return undefined;

  return normalizeOverrideKeys(keys as Array<string>);
}

export function selectOverrideValuesFromEnv(
  env: Record<string, string | undefined>,
  overrideKeys: Array<string>,
) {
  const selected: Record<string, string | undefined> = {};
  for (const key of overrideKeys) {
    if (key in env) selected[key] = env[key];
  }
  return selected;
}
