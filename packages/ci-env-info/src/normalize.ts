/**
 * Shared parsers for CI env values: ref → branch, repo string → { owner, name }, env value → deployment enum.
 */

export type DeploymentEnvironment = (
  'development'
  | 'preview'
  | 'staging'
  | 'production'
  | 'test'
);

export interface RepoParts {
  owner: string;
  name: string;
}

/**
 * Parse a git ref (e.g. GITHUB_REF) into a short branch name.
 * - refs/heads/feat/foo → feat/foo
 * - refs/pull/123/merge → (PR context; returns undefined or branch from HEAD)
 */
export function refToBranch(ref: string | undefined): string | undefined {
  if (!ref || typeof ref !== 'string') return undefined;
  const s = ref.trim();
  if (s.startsWith('refs/heads/')) return s.slice('refs/heads/'.length);
  if (s.startsWith('refs/head/')) return s.slice('refs/head/'.length);
  return s;
}

/**
 * Parse a "owner/repo" string into { owner, name }.
 * Handles URLs that end with owner/repo or .git.
 */
export function parseRepoSlug(s: string | undefined): RepoParts | undefined {
  if (!s || typeof s !== 'string') return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  // URL like https://github.com/owner/repo or https://github.com/owner/repo.git
  let slug = trimmed;
  try {
    if (trimmed.includes('://') || trimmed.startsWith('git@')) {
      const url = new URL(trimmed.replace(/^git@([^:]+):/, 'https://$1/'));
      const path = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
      const parts = path.split('/');
      if (parts.length >= 2) {
        slug = `${parts[0]}/${parts[1]}`;
      }
    }
  } catch {
    // not a URL, use as-is
  }
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  const owner = slug.slice(0, idx);
  const name = slug.slice(idx + 1).replace(/\.git$/, '');
  if (!owner || !name) return undefined;
  return { owner, name };
}

/**
 * Parse PR number from env (string or number). For URLs (e.g. CircleCI CIRCLE_PULL_REQUEST),
 * extract the number from the path.
 */
export function parsePrNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  const s = String(value).trim();
  if (!s) return undefined;
  const n = parseInt(s, 10);
  if (!Number.isNaN(n) && n > 0) return n;
  // URL like https://github.com/owner/repo/pull/123
  const match = s.match(/\/pull\/(\d+)(?:\/|$)/) ?? s.match(/(\d+)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (!Number.isNaN(num) && num > 0) return num;
  }
  return undefined;
}

/**
 * Shorten commit SHA to 7 chars (or keep as-is if already short).
 */
export function shortSha(sha: string | undefined): string | undefined {
  if (!sha || typeof sha !== 'string') return undefined;
  const s = sha.trim();
  if (s.length >= 7) return s.slice(0, 7);
  return s || undefined;
}

/**
 * Map a platform-specific string to our normalized deployment environment.
 * Uses the given map (platform value -> enum); lookup is case-insensitive, then falls back to raw value.
 */
export function mapToDeploymentEnvironment(
  value: string | undefined,
  map: Record<string, DeploymentEnvironment>,
): DeploymentEnvironment | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const key = trimmed.toLowerCase();
  return map[key] ?? map[trimmed];
}
