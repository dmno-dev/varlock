export type GlobMatcher = { test: (str: string) => boolean };

/**
 * Compile a simple glob pattern into a matcher for a whole string. Supports `*` (any run of
 * characters) and `?` (single character); every other character matches literally.
 * Used by key filters (`@setValuesBulk` and `@import` pick/omit, `--filter`) and
 * `@auditIgnoreKeys`. Matching is case-sensitive, since env keys are case-sensitive.
 *
 * This is a loop and not a regex on purpose: `^.*A.*A.*A$` backtracks polynomially in the
 * number of stars, and a pattern with 8 stars took about a minute against one 60-character key.
 */
export function compileGlob(pattern: string): GlobMatcher {
  return {
    test(str: string) {
      // greedy matching, and on a mismatch go back to the most recent star only
      let p = 0;
      let s = 0;
      let starP = -1;
      let starS = 0;
      while (s < str.length) {
        if (pattern[p] === '*') {
          starP = p++;
          starS = s;
        } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === str[s])) {
          p++;
          s++;
        } else if (starP !== -1) {
          p = starP + 1;
          s = ++starS;
        } else {
          return false;
        }
      }
      while (pattern[p] === '*') p++;
      return p === pattern.length;
    },
  };
}
