import ansis from 'ansis';

const MAX_LISTED_KEYS = 5;
const MAX_KEY_LIST_LENGTH = 80;

/**
 * Comma-joins failing keys for a one-line summary, capped by count and length so the line
 * survives tools that only keep a short tail of the output (e.g. k8s termination messages).
 * Always lists at least one key.
 */
export function formatKeyList(keys: Array<string>) {
  const listed: Array<string> = [];
  let length = 0;
  for (const key of keys) {
    if (listed.length >= MAX_LISTED_KEYS) break;
    const nextLength = length + (listed.length ? 2 : 0) + key.length;
    if (listed.length && nextLength > MAX_KEY_LIST_LENGTH) break;
    listed.push(key);
    length = nextLength;
  }
  const remaining = keys.length - listed.length;
  if (remaining > 0) listed.push(`+${remaining} more`);
  return listed.join(', ');
}

/**
 * Thrown when resolved config fails validation.
 *
 * Kept in its own module (rather than alongside the `checkFor*` helpers in
 * `error-checks.ts`) so the CLI entry point can catch it without importing
 * those helpers, which pull in the whole env-graph barrel.
 */
export class InvalidEnvError extends Error {
  constructor(readonly failingKeys: Array<string> = []) {
    // key names come from the schema, never values, so they are safe to print
    super(failingKeys.length ? `Invalid env vars: ${formatKeyList(failingKeys)}` : 'Invalid env vars');
  }
  getFormattedOutput() {
    return `\n💥 ${ansis.red(`[varlock] ${this.message}`)} 💥\n`;
  }
}
