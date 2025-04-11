const VALID_NUMBER_REGEX = /^(0|([1-9][0-9]*))?(\.[0-9]+)?$/;
export function autoCoerce(valStr) {
  if (valStr === 'true') return true;
  if (valStr === 'false') return false;
  if (valStr === 'undefined') return undefined;
  // not handling `null` because its a JS specific thing... we'll try to avoid it altogether

  // special check to avoid weird number coercion like `01`, `1e10`
  if (VALID_NUMBER_REGEX.test(valStr)) return Number(valStr);
  return valStr;
}
