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

/**
 * The string form a blob config item takes when injected into process.env
 * (same formula as initVarlockEnv / `varlock run`'s individual-var injection).
 */
export function injectedEnvStringForm(item: { envStr?: string, value?: any }): string {
  return item.envStr ?? (item.value === undefined ? '' : String(item.value));
}

/**
 * Whether an ambient env value is just this blob item's own value echoing back - either
 * the injected string form, or the raw pre-coercion override string the parent recorded
 * (e.g. `FLAG=YES` coerced to boolean `true`: the raw "YES" survives in the child env
 * under `--inject blob`, where no individual vars are injected over it).
 */
type BlobConfigItem = { envStr?: string, value?: any, overrideStr?: string };

export function envValueMatchesBlobItem(
  envValue: string | undefined,
  item: BlobConfigItem,
): boolean {
  if (envValue === injectedEnvStringForm(item)) return true;
  return item.overrideStr !== undefined && envValue === item.overrideStr;
}

/**
 * Select the env values that should act as overrides for a fresh resolution running
 * under an injected `__VARLOCK_ENV` blob:
 *
 *  - keys the blob RECORDS as genuine overrides at the parent invocation (their current
 *    env value is re-read, so a changed value is honored)
 *  - any other blob config key whose current env value DIFFERS from what the parent
 *    injected. A parent echo is by definition equal to the blob's injected value, so a
 *    differing value must have been introduced deliberately after the parent resolved
 *    (e.g. `varlock run -- sh -c 'FOO=x node app.js'` where FOO was not overridden at
 *    the parent) and is a genuine override, even though the parent didn't record it.
 *
 * Unchanged parent-injected values match the blob and are excluded, preserving the core
 * rule that parent-injected values must not shadow fresh resolution.
 *
 * Returns undefined when the blob is missing/unparseable or carries no override
 * provenance at all (older producers), so callers can fall back to default behavior.
 */
export function selectOverridesFromInjectedEnv(
  blob: string | undefined,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  const overrideKeys = parseBlobOverrideKeys(blob);
  if (!overrideKeys) return undefined;

  const selected = selectOverrideValuesFromEnv(env, overrideKeys);

  // blob is known-parseable here (parseBlobOverrideKeys succeeded)
  const config = (JSON.parse(blob!) as { config?: unknown }).config;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    for (const [key, item] of Object.entries(config as Record<string, BlobConfigItem>)) {
      if (key in selected) continue;
      if (!(key in env)) continue; // absent (e.g. `--inject blob` mode) is not a divergence
      if (!envValueMatchesBlobItem(env[key], item)) selected[key] = env[key];
    }
  }
  return selected;
}
