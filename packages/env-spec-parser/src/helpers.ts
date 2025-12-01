// this regex helps avoid any weird numbers
// - leading zeros
// - scientific notation
// - multiple decimal points
const VALID_NUMBER_REGEX = /^-?(0|([1-9][0-9]*))?(\.[0-9]+)?$/;

export function autoCoerce(valStr: string): string | number | boolean | undefined {
  if (valStr === 'true') return true;
  if (valStr === 'false') return false;
  if (valStr === 'undefined') return undefined;
  // not handling `null` because its a JS specific thing... we'll try to avoid it altogether

  // the regex check filters out a lot of ambiguous/weird cases
  if (VALID_NUMBER_REGEX.test(valStr)) {
    const num = Number(valStr);

    // Check if we can convert back to a string without any changes
    // this could be loss in precision or just formatting (extra zeros)
    const backToString = String(num);
    if (backToString !== valStr) return valStr;

    // if numbers are too large, we'll leave them as strings
    if (Number.isInteger(num) && !Number.isSafeInteger(num)) return valStr;
    if (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER) return valStr;

    // otherwise we can return the number
    return num;
  }
  return valStr;
}
