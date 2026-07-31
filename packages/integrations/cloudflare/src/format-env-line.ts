/**
 * Quote a value so dotenv/Wrangler reads it back unchanged from `.dev.vars`.
 *
 * Prefer a quote character that does not appear in the value (single → backtick →
 * double). Avoid backslash escapes: dotenv only expands `\n`/`\r` in double-quoted
 * values, so `\"` / `\\` would be left literal and corrupt secrets.
 *
 * @see https://github.com/cloudflare/workers-sdk/pull/13802
 */
export function quoteForDotenv(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('`')) {
    return `\`${value}\``;
  }
  // Double-quoted dotenv values still expand `\n`/`\r` (and leave other
  // backslashes alone inconsistently), so only use them when safe.
  if (!value.includes('"') && !/[\\\n\r]/.test(value)) {
    return `"${value}"`;
  }
  throw new Error(
    'Unable to serialize value to .dev.vars: contains every supported quote character or unsafe escape sequence.',
  );
}

/** Format a single `KEY=value` dotenv line with lossless quoting. */
export function formatEnvLine(key: string, value: string): string {
  return `${key}=${quoteForDotenv(value)}`;
}
