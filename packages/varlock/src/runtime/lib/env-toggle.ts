/** Parse a tri-state on/off/unset env toggle (e.g. `_VARLOCK_REDACT_STDOUT`). */
export function parseEnvToggle(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
}
