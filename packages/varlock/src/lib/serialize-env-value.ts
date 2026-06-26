import _ from '@env-spec/utils/my-dash';

/** Serialize a resolved config value for injection into `process.env`. */
export function serializeEnvValueForProcessEnv(value: unknown): string {
  if (value === undefined) return '';
  if (Array.isArray(value) || _.isPlainObject(value)) return JSON.stringify(value);
  return String(value);
}
