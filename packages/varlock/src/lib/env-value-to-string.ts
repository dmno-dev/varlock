/**
 * Convert a resolved env value to a string for process.env / child-process env.
 *
 * Matches `varlock load --format env` for non-strings (JSON.stringify).
 * Undefined becomes '' so injection matches other .env loaders.
 */
export function envValueToProcessEnvString(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Map a resolved env object to string values suitable for process/child env. */
export function mapResolvedEnvToProcessEnv(
  resolvedEnv: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(resolvedEnv)) {
    out[key] = envValueToProcessEnvString(resolvedEnv[key]);
  }
  return out;
}
