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

  it('detects GitHub Actions PR and extracts prNumber from GITHUB_REF', () => {
    expectCiEnv(
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_REF: 'refs/pull/42/merge',
        GITHUB_SHA: 'abc123',
        GITHUB_EVENT_NAME: 'pull_request',
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

  it('detects GitHub Actions PR and uses GITHUB_HEAD_REF as branch name', () => {
    expectCiEnv(
      {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_REF: 'refs/pull/42/merge',
        GITHUB_HEAD_REF: 'feat-init-infra',
        GITHUB_SHA: 'abc123',
        GITHUB_EVENT_NAME: 'pull_request',
      },
      {
        isCI: true,
        name: 'GitHub Actions',
        isPR: true,
        prNumber: 42,
        branch: 'feat-init-infra',
        fullRepoName: 'owner/repo',
      },
    );
  });

  it('does not misparse a digit-suffixed branch name as a PR number on push builds', () => {
    expectCiEnv(
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_REF: 'refs/heads/feature-123',
        GITHUB_REF_NAME: 'feature-123',
        GITHUB_SHA: 'abc123',
        GITHUB_EVENT_NAME: 'push',
      },
      {
        isCI: true,
        isPR: false,
        prNumber: undefined,
        branch: 'feature-123',
      },
    );
  });

  it('prefers GITHUB_REF_NAME for branch when GITHUB_HEAD_REF is absent', () => {
    expectCiEnv(
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_REF: 'refs/heads/feat/foo',
        GITHUB_REF_NAME: 'feat/foo',
        GITHUB_SHA: 'abc123',
        GITHUB_EVENT_NAME: 'push',
      },
      { branch: 'feat/foo' },
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
        DEPLOY_URL: 'https://random-name-123.netlify.app',
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
        CI_MERGE_REQUEST_ID: '99999',
        CI_MERGE_REQUEST_IID: '10',
      },
      {
        isCI: true,
        name: 'GitLab CI',
        repo: { owner: 'group/subgroup', name: 'project' },
        fullRepoName: 'group/subgroup/project',
        isPR: true,
        prNumber: 10,
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

  it('detects Semaphore and extracts prNumber from SEMAPHORE_GIT_PR_NUMBER', () => {
    expectCiEnv(
      {
        SEMAPHORE: 'true',
        SEMAPHORE_GIT_REPO_SLUG: 'owner/repo',
        SEMAPHORE_GIT_BRANCH: 'main',
        SEMAPHORE_GIT_SHA: 'abc123',
        SEMAPHORE_GIT_PR_NUMBER: '7',
      },
      {
        isCI: true,
        name: 'Semaphore',
        isPR: true,
        prNumber: 7,
      },
    );
  });

  it('prefers SYSTEM_PULLREQUEST_PULLREQUESTNUMBER over PULLREQUESTID on Azure Pipelines', () => {
    expectCiEnv(
      {
        TF_BUILD: 'true',
        BUILD_REASON: 'PullRequest',
        SYSTEM_PULLREQUEST_PULLREQUESTID: '99999',
        SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '42',
      },
      {
        isCI: true,
        name: 'Azure Pipelines',
        isPR: true,
        prNumber: 42,
      },
    );
  });

  it('falls back to SYSTEM_PULLREQUEST_PULLREQUESTID when PULLREQUESTNUMBER is absent (Azure Repos)', () => {
    expectCiEnv(
      {
        TF_BUILD: 'true',
        BUILD_REASON: 'PullRequest',
        SYSTEM_PULLREQUEST_PULLREQUESTID: '15',
      },
      { prNumber: 15 },
    );
  });

  it('extracts Bitbucket repo owner from BITBUCKET_WORKSPACE', () => {
    expectCiEnv(
      {
        BITBUCKET_COMMIT: 'abc123',
        BITBUCKET_WORKSPACE: 'my-workspace',
        BITBUCKET_REPO_FULL_NAME: 'legacy-owner/repo',
        BITBUCKET_BRANCH: 'main',
      },
      {
        isCI: true,
        name: 'Bitbucket Pipelines',
        repo: { owner: 'my-workspace', name: 'repo' },
        fullRepoName: 'my-workspace/repo',
      },
    );
  });

  it('detects Bitrise and extracts repo from BITRISEIO_GIT_REPOSITORY_OWNER/_SLUG', () => {
    expectCiEnv(
      {
        BITRISE_IO: 'true',
        BITRISEIO_GIT_REPOSITORY_OWNER: 'owner',
        BITRISEIO_GIT_REPOSITORY_SLUG: 'repo',
        BITRISE_GIT_BRANCH: 'main',
        BITRISE_GIT_COMMIT: 'abc123',
      },
      {
        isCI: true,
        name: 'Bitrise',
        repo: { owner: 'owner', name: 'repo' },
        fullRepoName: 'owner/repo',
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

  it('detects Railway and extracts repo, branch, commit, environment, buildUrl', () => {
    expectCiEnv(
      {
        RAILWAY_ENVIRONMENT_ID: 'env-uuid',
        RAILWAY_ENVIRONMENT_NAME: 'production',
        RAILWAY_GIT_REPO_OWNER: 'owner',
        RAILWAY_GIT_REPO_NAME: 'repo',
        RAILWAY_GIT_BRANCH: 'main',
        RAILWAY_GIT_COMMIT_SHA: 'abc123',
        RAILWAY_DEPLOYMENT_ID: 'deploy-uuid',
        RAILWAY_PUBLIC_DOMAIN: 'my-app.up.railway.app',
      },
      {
        isCI: true,
        name: 'Railway',
        fullRepoName: 'owner/repo',
        branch: 'main',
        commitSha: 'abc123',
        runId: 'deploy-uuid',
        buildUrl: 'https://my-app.up.railway.app',
        environment: 'production',
      },
    );
  });

  it('detects AWS Amplify and extracts branch, commit, PR, runId', () => {
    expectCiEnv(
      {
        AWS_APP_ID: 'app-id',
        AWS_BRANCH: 'main',
        AWS_COMMIT_ID: 'abc123',
        AWS_JOB_ID: 'job-1',
        AWS_PULL_REQUEST_ID: '42',
      },
      {
        isCI: true,
        name: 'AWS Amplify',
        branch: 'main',
        commitSha: 'abc123',
        runId: 'job-1',
        isPR: true,
        prNumber: 42,
      },
    );
  });

  it('detects Google Cloud Run', () => {
    expectCiEnv(
      {
        K_SERVICE: 'my-service',
        K_REVISION: 'my-service-00001-abc',
      },
      {
        isCI: true,
        name: 'Google Cloud Run',
        runId: 'my-service-00001-abc',
      },
    );
  });

  it('detects Deno Deploy', () => {
    expectCiEnv(
      {
        DENO_DEPLOYMENT_ID: 'deployment-uuid',
      },
      {
        isCI: true,
        name: 'Deno Deploy',
        runId: 'deployment-uuid',
      },
    );
  });

  it('detects Zeabur and extracts repo, branch, commit', () => {
    expectCiEnv(
      {
        ZEABUR_SERVICE_ID: 'service-id',
        ZEABUR_GIT_REPO_OWNER: 'owner',
        ZEABUR_GIT_REPO_NAME: 'repo',
        ZEABUR_GIT_BRANCH: 'main',
        ZEABUR_GIT_COMMIT_SHA: 'abc123',
      },
      {
        isCI: true,
        name: 'Zeabur',
        fullRepoName: 'owner/repo',
        branch: 'main',
        commitSha: 'abc123',
      },
    );
  });

  it('detects Firebase App Hosting', () => {
    expectCiEnv(
      {
        FIREBASE_APP_HOSTING: 'true',
      },
      {
        isCI: true,
        name: 'Firebase App Hosting',
      },
    );
  });

  it('detects CodeSandbox as isCI: false', () => {
    expectCiEnv(
      { CODESANDBOX_SSE: 'true' },
      { isCI: false, name: 'CodeSandbox' },
    );
  });

  it('detects GitHub Codespaces as isCI: false and extracts repo', () => {
    expectCiEnv(
      { CODESPACES: 'true', GITHUB_REPOSITORY: 'owner/repo' },
      { isCI: false, name: 'GitHub Codespaces', fullRepoName: 'owner/repo' },
    );
  });

  it('detects Gitpod as isCI: false', () => {
    expectCiEnv(
      { GITPOD_WORKSPACE_ID: 'workspace-id' },
      { isCI: false, name: 'Gitpod' },
    );
  });

  it('detects Replit as isCI: false', () => {
    expectCiEnv(
      { REPL_ID: 'repl-id' },
      { isCI: false, name: 'Replit' },
    );
  });

  it('detects StackBlitz as isCI: false', () => {
    expectCiEnv(
      { SHELL: '/bin/jsh' },
      { isCI: false, name: 'StackBlitz' },
    );
  });
});
