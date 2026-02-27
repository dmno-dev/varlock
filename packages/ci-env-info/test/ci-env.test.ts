import { describe, expect, it } from 'vitest';
import { getCiEnv } from '../src/index';
import type { CiEnvInfo, EnvRecord } from '../src/types';

/**
 * Runs getCiEnv(env) and asserts that the result matches each key in expected.
 * Use for concise, declarative tests.
 */
function expectCiEnv(
  env: EnvRecord,
  expected: Partial<CiEnvInfo> & { raw?: Record<string, string> },
): CiEnvInfo {
  const info = getCiEnv(env);
  for (const key of Object.keys(expected) as Array<keyof CiEnvInfo>) {
    const exp = expected[key];
    if (key === 'raw') {
      expect(info.raw).toBeDefined();
      if (exp !== undefined && typeof exp === 'object' && exp !== null) {
        for (const [k, v] of Object.entries(exp)) {
          expect(info.raw![k]).toBe(v);
        }
      }
    } else {
      expect(info[key]).toEqual(exp);
    }
  }
  return info;
}

describe('getCiEnv', () => {
  it('returns isCI: false when env is empty', () => {
    expectCiEnv({}, { isCI: false, name: undefined });
  });

  it('returns isCI: false when CI=false (escape hatch)', () => {
    expectCiEnv(
      {
        CI: 'false',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      { isCI: false },
    );
  });

  it('detects GitHub Actions and extracts repo, branch, commit, isPR, runId, buildUrl, workflowName, actor, eventName', () => {
    expectCiEnv(
      {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'dmno-dev/varlock',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: 'abc123def456',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '123456789',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_ACTOR: 'octocat',
      },
      {
        isCI: true,
        name: 'GitHub Actions',
        repo: { owner: 'dmno-dev', name: 'varlock' },
        fullRepoName: 'dmno-dev/varlock',
        branch: 'main',
        commitSha: 'abc123def456',
        commitShaShort: 'abc123d',
        isPR: false,
        prNumber: undefined,
        runId: '123456789',
        buildUrl: 'https://github.com/dmno-dev/varlock/actions/runs/123456789',
        workflowName: 'CI',
        actor: 'octocat',
        eventName: 'push',
      },
    );
  });

  it('detects GitHub Actions PR and extracts prNumber', () => {
    expectCiEnv(
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_REF: 'refs/pull/42/merge',
        GITHUB_SHA: 'abc123',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_NUMBER: '42',
      },
      {
        isCI: true,
        name: 'GitHub Actions',
        isPR: true,
        prNumber: 42,
        fullRepoName: 'owner/repo',
      },
    );
  });

  it('detects Vercel and extracts environment and buildUrl', () => {
    expectCiEnv(
      {
        VERCEL: '1',
        VERCEL_GIT_REPO_OWNER: 'dmno-dev',
        VERCEL_GIT_REPO_SLUG: 'varlock',
        VERCEL_GIT_COMMIT_REF: 'main',
        VERCEL_GIT_COMMIT_SHA: 'abc123',
        VERCEL_ENV: 'production',
        VERCEL_URL: 'varlock-abc123.vercel.app',
      },
      {
        isCI: true,
        name: 'Vercel',
        repo: { owner: 'dmno-dev', name: 'varlock' },
        fullRepoName: 'dmno-dev/varlock',
        branch: 'main',
        commitSha: 'abc123',
        environment: 'production',
        buildUrl: 'https://varlock-abc123.vercel.app',
      },
    );
  });

  it('detects Vercel preview environment', () => {
    expectCiEnv(
      { VERCEL: '1', VERCEL_ENV: 'preview' },
      { environment: 'preview' },
    );
  });

  it('detects Netlify and extracts repo, branch, commit, context, runId, buildUrl', () => {
    expectCiEnv(
      {
        NETLIFY: 'true',
        REPOSITORY_URL: 'https://github.com/owner/repo.git',
        BRANCH: 'main',
        COMMIT_REF: 'abc123def',
        CONTEXT: 'production',
        BUILD_ID: 'build-abc-123',
        DEPLOY_URL: 'random-name-123.netlify.app',
      },
      {
        isCI: true,
        name: 'Netlify CI',
        repo: { owner: 'owner', name: 'repo' },
        fullRepoName: 'owner/repo',
        branch: 'main',
        commitSha: 'abc123def',
        environment: 'production',
        runId: 'build-abc-123',
        buildUrl: 'https://random-name-123.netlify.app',
      },
    );
  });

  it('detects CircleCI and extracts repo, branch, PR, commit', () => {
    expectCiEnv(
      {
        CIRCLECI: 'true',
        CIRCLE_REPOSITORY_URL: 'https://github.com/owner/repo',
        CIRCLE_BRANCH: 'feat/foo',
        CIRCLE_SHA1: 'deadbeef123456',
        CIRCLE_PULL_REQUEST: 'https://github.com/owner/repo/pull/99',
      },
      {
        isCI: true,
        name: 'CircleCI',
        repo: { owner: 'owner', name: 'repo' },
        fullRepoName: 'owner/repo',
        branch: 'feat/foo',
        commitSha: 'deadbeef123456',
        prNumber: 99,
      },
    );
  });

  it('detects GitLab CI and extracts repo, branch, MR, commit', () => {
    expectCiEnv(
      {
        GITLAB_CI: 'true',
        CI_PROJECT_PATH: 'group/subgroup/project',
        CI_COMMIT_REF_NAME: 'main',
        CI_COMMIT_SHA: 'abc123',
        CI_MERGE_REQUEST_ID: '10',
      },
      {
        isCI: true,
        name: 'GitLab CI',
        repo: { owner: 'group/subgroup', name: 'project' },
        fullRepoName: 'group/subgroup/project',
      },
    );
  });

  it('detects Cloudflare Workers CI', () => {
    expectCiEnv(
      {
        WORKERS_CI: '1',
        WORKERS_CI_BRANCH: 'main',
        WORKERS_CI_COMMIT_SHA: 'sha123',
      },
      {
        isCI: true,
        name: 'Cloudflare Workers',
        branch: 'main',
        commitSha: 'sha123',
      },
    );
  });

  it('detects Buildkite and extracts runId, buildUrl', () => {
    expectCiEnv(
      {
        BUILDKITE: 'true',
        BUILDKITE_REPO: 'https://github.com/owner/repo',
        BUILDKITE_BRANCH: 'main',
        BUILDKITE_COMMIT: 'abc123',
        BUILDKITE_BUILD_ID: 'build-uuid-456',
        BUILDKITE_BUILD_URL: 'https://buildkite.com/org/pipeline/builds/456',
      },
      {
        isCI: true,
        name: 'Buildkite',
        fullRepoName: 'owner/repo',
        branch: 'main',
        commitSha: 'abc123',
        runId: 'build-uuid-456',
        buildUrl: 'https://buildkite.com/org/pipeline/builds/456',
      },
    );
  });

  it('includes raw env vars when extractors use string keys', () => {
    expectCiEnv(
      {
        BUILDKITE: 'true',
        BUILDKITE_REPO: 'https://github.com/owner/repo',
        BUILDKITE_BRANCH: 'main',
        BUILDKITE_COMMIT: 'abc123',
      },
      {
        raw: {
          BUILDKITE_BRANCH: 'main',
          BUILDKITE_COMMIT: 'abc123',
        },
      },
    );
  });
});
