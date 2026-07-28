/**
 * Compile a simple glob pattern into an anchored regex. Supports `*` (any run of
 * characters) and `?` (single character); every other character matches literally.
 * Used by key filters (`@setValuesBulk` and `@import` pick/omit). Matching is
 * case-sensitive, since env keys are case-sensitive.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (leaving * and ?)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
