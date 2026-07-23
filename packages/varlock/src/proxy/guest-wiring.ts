import path from 'node:path';

/**
 * Translating a proxy session's env into the form a *remote guest* (a sandbox,
 * container, or microVM) needs. The proxy always emits loopback-relative wiring
 * (`HTTPS_PROXY=http://127.0.0.1:<port>`, absolute host CA paths). A guest reaches
 * the proxy at a different address (a tunnel's local port, a forwarder hostname)
 * and mounts the CA bundle at a different path, so both families of env var must
 * be repointed. This is the one place that knows which vars are which.
 */

/** CA-bundle env vars the proxy injects — each repoints to the guest CA dir. */
export const CA_PATH_ENV_VARS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO'];
/** Proxy-URL env vars — each repoints at the guest-side proxy address. */
export const PROXY_URL_ENV_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

/**
 * Embed a data-plane token into a proxy URL as basic-auth credentials, so a
 * client's `HTTP(S)_PROXY` auto-sends `Proxy-Authorization`. Fixed username
 * (`varlock`); the token is the password. No-op when no token is given.
 */
export function proxyUrlWithToken(proxyUrl: string, token?: string): string {
  if (!token) return proxyUrl;
  try {
    const url = new URL(proxyUrl);
    url.username = 'varlock';
    url.password = token;
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

/**
 * Build the env a guest needs to route through the proxy: start from the
 * session's proxy env (CA paths + `NO_PROXY` + proxy URL), overlay the child
 * view (placeholders / non-secret values), then repoint the CA vars at
 * `guestCertDir` (keeping each file's basename, since the vars point at
 * *different* bundles) and the proxy-URL vars at `guestProxyUrl`. When
 * `dataPlaneToken` is set (the proxy binds off-loopback), the proxy-URL vars
 * carry it as basic-auth credentials so the guest authenticates automatically.
 */
export function buildGuestEnvWiring(opts: {
  /** The child-view env (`payload.env`): placeholders + non-secret values. */
  childEnv: Record<string, string>;
  /** The session's proxy env (HTTPS_PROXY, CA paths, NO_PROXY, ...). */
  sessionProxyEnv: Record<string, string>;
  /** URL the guest uses to reach the proxy, e.g. `http://127.0.0.1:8888`. */
  guestProxyUrl: string;
  /** Directory the guest mounts/writes the CA bundle files into. */
  guestCertDir: string;
  /** Data-plane token for an off-loopback proxy; embedded into the proxy URL. */
  dataPlaneToken?: string;
}): Record<string, string> {
  const guestProxyUrl = proxyUrlWithToken(opts.guestProxyUrl, opts.dataPlaneToken);
  const merged: Record<string, string> = { ...opts.sessionProxyEnv, ...opts.childEnv };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (CA_PATH_ENV_VARS.includes(key)) env[key] = `${opts.guestCertDir}/${path.basename(value)}`;
    else if (PROXY_URL_ENV_VARS.includes(key)) env[key] = guestProxyUrl;
    else env[key] = value;
  }
  return env;
}

/**
 * The proxy + CA env a guest sets to route through a loopback proxy at
 * `proxyUrl` with the CA bundle files in `certDir`. Mirrors the runtime's own
 * env output — `NODE_EXTRA_CA_CERTS` points at the proxy-CA-only bundle, the
 * OpenSSL/curl/git vars at the system+proxy combined bundle. Used by
 * `proxy run --url`, which knows its own local port and cert dir.
 */
export function guestLoopbackWiring(proxyUrl: string, certDir: string): Record<string, string> {
  const env: Record<string, string> = {
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    NODE_EXTRA_CA_CERTS: `${certDir}/ca-cert.pem`,
  };
  for (const key of PROXY_URL_ENV_VARS) env[key] = proxyUrl;
  for (const key of CA_PATH_ENV_VARS) {
    if (key !== 'NODE_EXTRA_CA_CERTS') env[key] = `${certDir}/combined-ca.pem`;
  }
  return env;
}

/**
 * The absolute host directory the proxy wrote its CA bundle files into, derived
 * from whichever CA path env var is present. Callers read the PEM files from here
 * to ship them into a guest.
 */
export function caDirFromSessionEnv(sessionProxyEnv: Record<string, string>): string {
  const caPath = CA_PATH_ENV_VARS
    .map((key) => sessionProxyEnv[key])
    .find((value): value is string => Boolean(value));
  if (!caPath) {
    throw new Error('Proxy session env is missing a CA bundle path. Restart the proxy session.');
  }
  return path.dirname(caPath);
}
