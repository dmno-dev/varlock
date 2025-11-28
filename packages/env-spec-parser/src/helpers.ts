const VALID_NUMBER_REGEX = /^(0|([1-9][0-9]*))?(\.[0-9]+)?$/;
export function autoCoerce(valStr: string): string | number | boolean | undefined {
  if (valStr === 'true') return true;
  if (valStr === 'false') return false;
  if (valStr === 'undefined') return undefined;
  // not handling `null` because its a JS specific thing... we'll try to avoid it altogether

  // special check to avoid weird number coercion like `01`, `1e10`
  if (VALID_NUMBER_REGEX.test(valStr)) {
    const num = Number(valStr);
    // If the number is not finite, preserve as string
    if (!Number.isFinite(num)) {
      return valStr;
    }
    // For integers, check if they're within safe integer bounds
    // Numbers beyond MAX_SAFE_INTEGER can lose precision
    if (Number.isInteger(num) && !Number.isSafeInteger(num)) {
      return valStr;
    }
    // Check if conversion back to string uses scientific notation
    // This catches very large numbers that get converted to scientific notation
    // For example: '92183090832018209318123781721.12231' -> '9.21830908320182e+28' (precision lost)
    const backToString = String(num);
    if (backToString.includes('e') || backToString.includes('E')) {
      return valStr;
    }
    // Check if the number is outside safe bounds for floating point precision
    // Numbers with absolute value > MAX_SAFE_INTEGER may lose precision
    if (Math.abs(num) > Number.MAX_SAFE_INTEGER) {
      return valStr;
    }
    return num;
  }
  return valStr;
}
