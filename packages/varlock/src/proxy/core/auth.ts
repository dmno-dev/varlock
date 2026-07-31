/**
 * Constant-time token comparison (length leak is fine; the token is a uuid, not
 * a password). Char-code XOR accumulation rather than node's `timingSafeEqual`
 * so it runs on any runtime.
 */
export function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

/** True if a listen host binds only loopback (so remote peers can't reach it). */
export function isLoopbackBind(host: string): boolean {
  return host === 'localhost' || isLoopbackAddress(host);
}

/** Extract the token from a `Proxy-Authorization: Basic base64(user:token)` header. */
export function parseProxyAuthToken(header: string | Array<string> | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  const spaceIdx = value.indexOf(' ');
  if (spaceIdx === -1) return undefined;
  const scheme = value.slice(0, spaceIdx);
  const encoded = value.slice(spaceIdx + 1).trim();
  if (scheme.toLowerCase() !== 'basic' || !encoded) return undefined;
  let decoded: string;
  try {
    // atob + TextDecoder rather than Buffer so this runs on any runtime.
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(':');
  // Basic is `user:pass`; the token is the password half (username is cosmetic).
  return colon === -1 ? decoded : decoded.slice(colon + 1);
}

/**
 * Data-plane gate. Loopback peers are same-uid-trusted and always pass (the
 * historical model). A non-loopback peer — only reachable when the listener is
 * bound off-loopback — must present the session's `Proxy-Authorization` token.
 */
export function dataPlaneAuthOk(
  peerAddr: string | undefined,
  header: string | Array<string> | undefined,
  token: string | undefined,
): boolean {
  if (isLoopbackAddress(peerAddr)) return true;
  if (!token) return false; // non-loopback bind without a token: fail closed
  return tokenMatches(parseProxyAuthToken(header), token);
}
