/**
 * Formats a string value for safe use in a shell export statement.
 * Uses single-quoted strings to prevent shell injection via backticks, `$`, etc.
 * Single quotes within the value are escaped using the `'\''` sequence.
 */
export function formatShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
