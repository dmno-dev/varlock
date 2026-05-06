/**
 * Shared utility for acquiring OIDC tokens from deployment platforms.
 * Used by secret provider plugins to authenticate via workload identity federation.
 */

export type OidcPlatform = 'vercel' | 'github-actions' | 'fly' | 'gcp' | 'gitlab';

export interface OidcTokenResult {
  token: string;
  platform: OidcPlatform;
}

/**
 * Vercel exposes OIDC tokens via the `VERCEL_OIDC_TOKEN` env var during builds
 * and serverless function execution.
 */
export function getVercelOidcToken(): string | undefined {
  if (!process.env.VERCEL) return undefined;
  return process.env.VERCEL_OIDC_TOKEN || undefined;
}

/**
 * GitHub Actions provides OIDC tokens by POSTing to a request URL with a bearer token.
 * Requires `permissions: id-token: write` in the workflow.
 */
export async function getGitHubActionsOidcToken(
  audience?: string,
): Promise<string | undefined> {
  if (!process.env.GITHUB_ACTIONS) return undefined;

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return undefined;

  try {
    const url = new URL(requestUrl);
    if (audience) {
      url.searchParams.set('audience', audience);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${requestToken}`,
        Accept: 'application/json; api-version=2.0',
      },
    });

    if (!response.ok) return undefined;

    const data = await response.json() as { value?: string };
    return data.value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * GitLab CI exposes OIDC tokens via the `CI_JOB_JWT_V2` env var
 * (or `SIGSTORE_ID_TOKEN`).
 * Requires `id_tokens` configuration in .gitlab-ci.yml.
 */
export function getGitLabOidcToken(): string | undefined {
  if (!process.env.GITLAB_CI) return undefined;
  return process.env.CI_JOB_JWT_V2
    || process.env.SIGSTORE_ID_TOKEN
    || undefined;
}

/**
 * Fly.io provides OIDC tokens via an internal API endpoint.
 * Available to apps running on Fly Machines.
 */
export async function getFlyOidcToken(): Promise<string | undefined> {
  if (!process.env.FLY_APP_NAME) return undefined;

  try {
    const response = await fetch(
      'http://_api.internal:4280/v1/tokens/oidc',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );

    if (!response.ok) return undefined;

    const text = await response.text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * GCP Cloud Run / Cloud Functions expose identity tokens via the metadata
 * server. Requires that the service has a service account with appropriate
 * permissions.
 */
export async function getGcpOidcToken(
  audience?: string,
): Promise<string | undefined> {
  try {
    const url = new URL(
      'http://metadata.google.internal/computeMetadata/v1'
      + '/instance/service-accounts/default/identity',
    );
    if (audience) {
      url.searchParams.set('audience', audience);
    }

    const response = await fetch(url.toString(), {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) return undefined;

    const token = await response.text();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Auto-detect the deployment platform and fetch its OIDC token.
 * Returns undefined if not running on a supported platform or token
 * is unavailable.
 */
export async function getOidcToken(
  audience?: string,
): Promise<OidcTokenResult | undefined> {
  // Try each platform in order - first match wins
  let token: string | undefined;

  token = getVercelOidcToken();
  if (token) return { token, platform: 'vercel' };

  token = await getGitHubActionsOidcToken(audience);
  if (token) return { token, platform: 'github-actions' };

  token = getGitLabOidcToken();
  if (token) return { token, platform: 'gitlab' };

  token = await getFlyOidcToken();
  if (token) return { token, platform: 'fly' };

  token = await getGcpOidcToken(audience);
  if (token) return { token, platform: 'gcp' };

  return undefined;
}
