/** Validates a Dashlane service device keys string (dls_*) */
export function validateDeviceKeys(val: string): string | undefined {
  if (!val.startsWith('dls_')) {
    return 'Service device keys must start with "dls_"';
  }
  if (val.length < 10) {
    return 'Service device keys appear too short';
  }
}

/** Validates a Dashlane secret reference URI (dl://*) */
export function validateSecretRef(val: string): string | undefined {
  if (!val.startsWith('dl://')) {
    return 'Secret reference must start with "dl://"';
  }
  if (val === 'dl://') {
    return 'Secret reference must include a secret identifier after "dl://"';
  }
}
