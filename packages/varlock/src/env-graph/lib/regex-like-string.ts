// Kept dependency-free so modules outside the resolver (e.g. data-types, which the frozen env
// boot path loads without the rest of the graph engine) can use it.

export const REGEX_LIKE_STRING = /^\/(.+)\/([dgimsuvy]*)$/;

/** Try to parse an unquoted string like `/pattern/flags` into a RegExp. Returns null if not regex-like. */
export function parseRegexLikeString(str: string): RegExp | null {
  if (typeof str !== 'string') return null;
  const match = str.match(REGEX_LIKE_STRING);
  if (!match) return null;
  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return null;
  }
}
