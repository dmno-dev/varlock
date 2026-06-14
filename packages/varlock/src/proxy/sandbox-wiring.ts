import path from 'node:path';

import { getProxySessionExportEnv, type ProxySessionRecord } from './session-registry';

/**
 * Helpers for wiring a detached proxy session into an external sandbox runtime.
 *
 * The proxy already assumes the sandbox boundary as its trust boundary: a guest
 * on an isolated network can only reach the host gateway, so a proxy bound there
 * (`proxy start --bind <gateway>:<port>`) becomes the guest's sole egress. These
 * helpers translate a session into the env + mount a guest needs:
 *   - repoint the CA-bundle env vars at the path the CA is mounted to in-guest,
 *   - carry the @proxy placeholder values so the guest's SDKs send placeholders
 *     (the proxy swaps them for real secrets against the verified TLS identity).
 */

/**
 * Where the proxy certs directory is mounted inside the sandbox guest. Apple
 * `container` bind mounts must target a directory, and the proxy's certs dir
 * holds only public certs (private keys never touch disk), so mounting the
 * whole directory read-only is safe.
 */
export const SANDBOX_GUEST_CA_DIR = '/etc/varlock/proxy-certs';

/** CA-bundle env vars the proxy injects — all repoint to the in-guest mount. */
const CA_PATH_ENV_VARS = [
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

export type BindAddress = { host: string; port?: number };

function parsePort(raw: string, original: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in --bind "${original}" (expected 1-65535)`);
  }
  return port;
}

/**
 * Parse a `--bind` value: `host`, `host:port`, or `:port`. IPv6 must be
 * bracketed when a port is present (`[::1]:8888`); a bare IPv6 (`::1`) is
 * treated as host-only.
 */
export function parseBindAddress(raw: string): BindAddress {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('--bind requires a value like "192.168.64.1:8888"');

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) throw new Error(`Invalid --bind value "${raw}" (unterminated IPv6 bracket)`);
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    if (!rest) return { host };
    if (!rest.startsWith(':')) throw new Error(`Invalid --bind value "${raw}"`);
    return { host, port: parsePort(rest.slice(1), raw) };
  }

  const lastColon = trimmed.lastIndexOf(':');
  // No colon, or multiple colons (bare IPv6) → host only.
  if (lastColon === -1 || trimmed.indexOf(':') !== lastColon) {
    return { host: trimmed };
  }
  const host = trimmed.slice(0, lastColon);
  return { host: host || '0.0.0.0', port: parsePort(trimmed.slice(lastColon + 1), raw) };
}

export type SandboxWiring = {
  /** Guest-ready env: CA paths repointed in-guest, @proxy placeholders included. */
  env: Record<string, string>;
  /** Host directory (proxy certs dir, public certs only) to bind-mount into the guest. */
  caHostDir: string;
  /** Directory the certs are mounted to inside the guest. */
  caGuestDir: string;
  /** Full path to the CA bundle inside the guest. */
  caGuestPath: string;
  /** The proxy URL the guest will use, e.g. `http://192.168.64.1:8888`. */
  proxyUrl?: string;
  /** True when the proxy URL is loopback — unreachable from a guest (missing `--bind`). */
  proxyIsLoopback: boolean;
};

function hostnameOf(proxyUrl?: string): string | undefined {
  if (!proxyUrl) return undefined;
  try {
    return new URL(proxyUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Translate a detached proxy session into the env + CA mount a sandbox guest
 * needs. Pure — performs no IO and starts nothing.
 */
export function buildSandboxWiring(session: ProxySessionRecord): SandboxWiring {
  const raw = getProxySessionExportEnv(session);
  const caHostSource = raw.SSL_CERT_FILE ?? raw.NODE_EXTRA_CA_CERTS;
  if (!caHostSource) {
    throw new Error('Proxy session env is missing a CA bundle path. Restart the proxy session.');
  }
  const caHostDir = path.dirname(caHostSource);
  const caGuestPath = `${SANDBOX_GUEST_CA_DIR}/${path.basename(caHostSource)}`;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    env[key] = CA_PATH_ENV_VARS.includes(key) ? caGuestPath : value;
  }
  // Carry @proxy placeholder values so the guest's SDKs hold placeholders, not
  // real secrets. The proxy substitutes them against the verified TLS identity.
  for (const [key, placeholder] of Object.entries(session.placeholderOverrides ?? {})) {
    env[key] = placeholder;
  }

  const proxyUrl = raw.HTTPS_PROXY ?? raw.HTTP_PROXY;
  const proxyHost = hostnameOf(proxyUrl);

  return {
    env,
    caHostDir,
    caGuestDir: SANDBOX_GUEST_CA_DIR,
    caGuestPath,
    ...(proxyUrl ? { proxyUrl } : {}),
    proxyIsLoopback: proxyHost ? LOOPBACK_HOSTS.has(proxyHost) : true,
  };
}

/** Single-quote a value for safe pasting into a POSIX shell. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Render the wiring as `container run` flag lines (Apple `container`): a CA
 * bind-mount followed by `-e KEY=VALUE` env flags. Network, image and command
 * are left to the caller to append.
 */
export function formatAppleContainerRunFlags(wiring: SandboxWiring): string {
  const lines: Array<string> = [`--mount type=bind,source=${wiring.caHostDir},target=${wiring.caGuestDir},readonly`];
  for (const [key, value] of Object.entries(wiring.env)) {
    lines.push(`-e ${shellSingleQuote(`${key}=${value}`)}`);
  }
  return lines.join(' \\\n  ');
}
