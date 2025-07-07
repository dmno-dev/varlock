
export type RedactMode = 'show_first_2' | 'show_last_2' | 'show_first_last';

/**
 * utility to mask/redact a string, for example transforming "hello" into "he▒▒▒"
 * this function just redacts _any_ string passed in
 *
 * To redact sensitive parts of a larger object/string, use redactSensitiveConfig
 * */
export function redactString(valStr: string | undefined, mode?: RedactMode, hideLength = true) {
  if (!valStr) return valStr;

  const hiddenLength = hideLength ? 5 : valStr.length - 2;
  const hiddenStr = '▒'.repeat(hiddenLength);

  if (mode === 'show_last_2') {
    return `${hiddenStr}${valStr.substring(valStr.length - 2, valStr.length)}`;
  } else if (mode === 'show_first_last') {
    return `${valStr.substring(0, 1)}${hiddenStr}${valStr.substring(valStr.length - 1, valStr.length)}`;
  } else { // 'show_first_2' - also default
    return `${valStr.substring(0, 2)}${hiddenStr}`;
  }
}
