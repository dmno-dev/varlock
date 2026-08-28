/**
 * Parsing and building of `varlock()` reference strings.
 *
 * A reference looks like `varlock("<scheme>:<payload>")`. The scheme says where
 * the payload came from and which backend can turn it back into a value. Today
 * `local` (device-local encryption) is the only registered scheme.
 *
 * Payloads written before schemes existed have no prefix at all. Those are still
 * read as `local`, so old env files keep working.
 */

/** Device-local encryption (Secure Enclave / TPM / file fallback) */
export const LOCAL_SCHEME = 'local';

/**
 * Every scheme this build knows how to resolve. Adding a scheme here is what
 * makes `varlock("<scheme>:...")` stop being an error.
 */
export const VARLOCK_SCHEMES = {
  [LOCAL_SCHEME]: { label: 'device-local encryption' },
} as const;

export type VarlockScheme = keyof typeof VARLOCK_SCHEMES;

/**
 * Matches a leading `<scheme>:` prefix.
 *
 * Base64 payloads never contain a colon, so a legacy prefixless payload cannot
 * accidentally match this and get read as a scheme.
 */
const SCHEME_PREFIX_REGEX = /^([a-zA-Z][a-zA-Z0-9_]*):([\s\S]*)$/;

export type ParsedVarlockReference = {
  scheme: VarlockScheme;
  /** the reference with its scheme prefix removed */
  payload: string;
};

export function isKnownVarlockScheme(scheme: string): scheme is VarlockScheme {
  return Object.hasOwn(VARLOCK_SCHEMES, scheme);
}

function unknownSchemeError(scheme: string) {
  const known = Object.keys(VARLOCK_SCHEMES).map((s) => `"${s}"`).join(', ');
  return new Error(`unknown varlock() scheme "${scheme}" (known schemes: ${known})`);
}

/**
 * Build the reference string written into env files.
 * This is the only place a `varlock("...")` string should be assembled.
 */
export function buildVarlockReference(scheme: VarlockScheme, ciphertext: string): string {
  if (!isKnownVarlockScheme(scheme)) throw unknownSchemeError(scheme);
  return `varlock("${scheme}:${ciphertext}")`;
}

/**
 * Split a `varlock()` argument into its scheme and payload.
 * Throws when the reference names a scheme this build does not know.
 */
export function parseVarlockReference(reference: string): ParsedVarlockReference {
  const match = SCHEME_PREFIX_REGEX.exec(reference);
  if (!match) {
    // no prefix at all: predates schemes, and those payloads were always local
    return { scheme: LOCAL_SCHEME, payload: reference };
  }
  const [, scheme, payload] = match;
  if (!isKnownVarlockScheme(scheme)) throw unknownSchemeError(scheme);
  return { scheme, payload };
}
