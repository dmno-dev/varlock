/** Result of looking up a key in parsed JSON. */
export type JsonKeyLookup = | { found: true, value: string }
  | { found: false, availableKeys: Array<string> };

function isContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toStringValue(value: unknown): string {
  return isContainer(value) ? JSON.stringify(value) : String(value);
}

/**
 * Looks up `key` in a parsed JSON value.
 *
 * An exact top-level key wins, so keys that contain dots keep working. Otherwise `key` is read as a
 * dot-separated path: `db.host` reads `value.db.host`. Object and array results are returned as JSON text.
 */
export function lookupJsonKey(parsed: unknown, key: string): JsonKeyLookup {
  if (isContainer(parsed) && Object.prototype.hasOwnProperty.call(parsed, key)) {
    return { found: true, value: toStringValue(parsed[key]) };
  }

  let current: unknown = parsed;
  for (const segment of key.split('.')) {
    if (!isContainer(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, availableKeys: isContainer(current) ? Object.keys(current) : [] };
    }
    current = current[segment];
  }

  return { found: true, value: toStringValue(current) };
}
