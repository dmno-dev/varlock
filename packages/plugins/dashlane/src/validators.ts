/** Validates a Dashlane service device keys string (dls_*) */
export function validateDeviceKeys(val: unknown): string | undefined {
  if (typeof val !== 'string') {
    return 'Service device keys must be a string';
  }
  if (!val.startsWith('dls_')) {
    return 'Service device keys must start with "dls_"';
  }
  if (val.length < 10) {
    return 'Service device keys appear too short';
  }
}
