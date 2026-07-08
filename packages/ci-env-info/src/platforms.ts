import type { EnvRecord, PlatformDefinition } from './types';
import {
  parsePrNumber,
  parseRepoSlug,
  refToBranch,
} from './normalize';

/** Helper: detect when env key has one of the values */
function envEq(name: string, value: string): (env: EnvRecord) => boolean {
  return (env) => env[name] === value;
}

/** Helper: detect when all of the env vars are set */
function envAll(...names: Array<string>): (env: EnvRecord) => boolean {
  return (env) => names.every((n) => !!env[n]);
}

/** Helper: detect when any of the env vars are set */
function envAny(...names: Array<string>): (env: EnvRecord) => boolean {
  return (env) => names.some((n) => !!env[n]);
}

export const PLATFORMS: Array<PlatformDefinition> = [
  // Very common (alpha) ---
  {
    name: 'Cloudflare Pages',
    docsUrl: 'https://developers.cloudflare.com/pages/configuration/build-configuration/#environment-variables',
    detect: 'CF_PAGES',
    branch: 'CF_PAGES_BRANCH',
    commitSha: 'CF_PAGES_COMMIT_SHA',
    buildUrl: 'CF_PAGES_URL',
  },
  {
    name: 'Cloudflare Workers',
    docsUrl: 'https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables',
    detect: 'WORKERS_CI',
    branch: 'WORKERS_CI_BRANCH',
    commitSha: 'WORKERS_CI_COMMIT_SHA',
    runId: 'WORKERS_CI_BUILD_UUID',
  },
  {
    name: 'GitHub Actions',
    docsUrl: 'https://docs.github.com/en/actions/learn-github-actions/variables',
    detect: 'GITHUB_ACTIONS',
    isPR: (env) => env.GITHUB_EVENT_NAME === 'pull_request',
    prNumber: (env) => (
      env.GITHUB_REF?.startsWith('refs/pull/') ? parsePrNumber(env.GITHUB_REF) : undefined
    ),
    repo: (env) => parseRepoSlug(env.GITHUB_REPOSITORY),
    branch: (env) => env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || refToBranch(env.GITHUB_REF),
    commitSha: 'GITHUB_SHA',
    runId: 'GITHUB_RUN_ID',
    buildUrl: (env) => {
      const server = env.GITHUB_SERVER_URL;
      const repo = env.GITHUB_REPOSITORY;
      const runId = env.GITHUB_RUN_ID;
      if (server && repo && runId) return `${server}/${repo}/actions/runs/${runId}`;
      return undefined;
    },
    workflowName: 'GITHUB_WORKFLOW',
    actor: 'GITHUB_ACTOR',
    eventName: 'GITHUB_EVENT_NAME',
  },
  {
    name: 'GitLab CI',
    docsUrl: 'https://docs.gitlab.com/ee/ci/variables/predefined_variables.html',
    detect: 'GITLAB_CI',
    isPR: 'CI_MERGE_REQUEST_ID',
    prNumber: 'CI_MERGE_REQUEST_IID',
    repo: (env) => {
      const path = env.CI_PROJECT_PATH;
      if (!path) return undefined;
      const parts = path.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return { owner: parts.slice(0, -1).join('/'), name: parts[parts.length - 1]! };
      }
      if (parts.length === 1) return { owner: parts[0]!, name: parts[0]! };
      return undefined;
    },
    branch: 'CI_COMMIT_REF_NAME',
    commitSha: 'CI_COMMIT_SHA',
    runId: 'CI_PIPELINE_ID',
    buildUrl: 'CI_PIPELINE_URL',
  },
  {
    name: 'Netlify CI',
    docsUrl: 'https://docs.netlify.com/configure-builds/environment-variables',
    detect: 'NETLIFY',
    isPR: (env) => env.PULL_REQUEST !== undefined && env.PULL_REQUEST !== 'false',
    repo: (env) => parseRepoSlug(env.REPOSITORY_URL),
    branch: (env) => env.HEAD ?? env.BRANCH,
    commitSha: 'COMMIT_REF',
    runId: 'BUILD_ID',
    buildUrl: 'DEPLOY_URL',
    environment: {
      var: 'CONTEXT',
      map: {
        production: 'production',
        'deploy-preview': 'preview',
        'branch-deploy': 'preview',
        dev: 'development',
      },
    },
  },
  {
    name: 'Vercel',
    docsUrl: 'https://vercel.com/docs/environment-variables/system-environment-variables',
    detect: envAny('NOW_BUILDER', 'VERCEL'),
    isPR: 'VERCEL_GIT_PULL_REQUEST_ID',
    prNumber: 'VERCEL_GIT_PULL_REQUEST_ID',
    repo: (env) => {
      const owner = env.VERCEL_GIT_REPO_OWNER;
      const name = env.VERCEL_GIT_REPO_SLUG;
      if (owner && name) return { owner, name };
      return parseRepoSlug(env.VERCEL_GIT_REPO_SLUG);
    },
    branch: 'VERCEL_GIT_COMMIT_REF',
    commitSha: 'VERCEL_GIT_COMMIT_SHA',
    buildUrl: (env) => (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined),
    environment: 'VERCEL_ENV',
    runId: 'VERCEL_DEPLOYMENT_ID',
  },

  // Somewhat common (alpha) ---
  {
    name: 'AWS Amplify',
    docsUrl: 'https://docs.aws.amazon.com/amplify/latest/userguide/environment-variables.html',
    detect: 'AWS_APP_ID',
    isPR: 'AWS_PULL_REQUEST_ID',
    prNumber: (env) => parsePrNumber(env.AWS_PULL_REQUEST_ID),
    repo: (env) => parseRepoSlug(env.AWS_CLONE_URL),
    branch: 'AWS_BRANCH',
    commitSha: 'AWS_COMMIT_ID',
    runId: 'AWS_JOB_ID',
  },
  {
    name: 'AWS CodeBuild',
    docsUrl: 'https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-env-vars.html',
    detect: 'CODEBUILD_BUILD_ARN',
    isPR: (env) => ['PULL_REQUEST_CREATED', 'PULL_REQUEST_UPDATED', 'PULL_REQUEST_REOPENED'].includes(
      env.CODEBUILD_WEBHOOK_EVENT ?? '',
    ),
    repo: (env) => parseRepoSlug(env.CODEBUILD_SOURCE_REPO_URL),
    branch: (env) => {
      const ref = env.CODEBUILD_WEBHOOK_HEAD_REF;
      return ref ? ref.replace(/^refs\/heads\//, '') : undefined;
    },
    commitSha: 'CODEBUILD_RESOLVED_SOURCE_VERSION',
  },
  {
    name: 'Azure Pipelines',
    docsUrl:
      'https://learn.microsoft.com/en-us/azure/devops/pipelines/build/variables?view=azure-devops&tabs=yaml',
    detect: 'TF_BUILD',
    isPR: (env) => env.BUILD_REASON === 'PullRequest',
    prNumber: (env) => (
      parsePrNumber(env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER)
      ?? parsePrNumber(env.SYSTEM_PULLREQUEST_PULLREQUESTID)
    ),
    branch: 'BUILD_SOURCEBRANCHNAME',
    commitSha: 'BUILD_SOURCEVERSION',
  },
  {
    name: 'Bitbucket Pipelines',
    docsUrl: 'https://support.atlassian.com/bitbucket-cloud/docs/variables-and-secrets',
    detect: 'BITBUCKET_COMMIT',
    isPR: 'BITBUCKET_PR_ID',
    prNumber: 'BITBUCKET_PR_ID',
    repo: (env) => {
      const owner = env.BITBUCKET_WORKSPACE ?? env.BITBUCKET_REPO_FULL_NAME?.split('/')[0];
      const name = env.BITBUCKET_REPO_FULL_NAME?.split('/').pop() ?? env.BITBUCKET_REPO_SLUG;
      if (owner && name) return { owner, name };
      return parseRepoSlug(env.BITBUCKET_REPO_FULL_NAME);
    },
    branch: 'BITBUCKET_BRANCH',
    commitSha: 'BITBUCKET_COMMIT',
  },
  {
    name: 'Buildkite',
    docsUrl: 'https://buildkite.com/docs/pipelines/environment-variables',
    detect: 'BUILDKITE',
    isPR: (env) => env.BUILDKITE_PULL_REQUEST !== undefined && env.BUILDKITE_PULL_REQUEST !== 'false',
    prNumber: 'BUILDKITE_PULL_REQUEST',
    repo: (env) => parseRepoSlug(env.BUILDKITE_REPO),
    branch: 'BUILDKITE_BRANCH',
    commitSha: 'BUILDKITE_COMMIT',
    runId: 'BUILDKITE_BUILD_ID',
    buildUrl: 'BUILDKITE_BUILD_URL',
  },
  {
    name: 'CircleCI',
    docsUrl: 'https://circleci.com/docs/reference/variables/',
    detect: 'CIRCLECI',
    isPR: 'CIRCLE_PULL_REQUEST',
    prNumber: 'CIRCLE_PULL_REQUEST',
    repo: (env) => parseRepoSlug(env.CIRCLE_REPOSITORY_URL),
    branch: 'CIRCLE_BRANCH',
    commitSha: 'CIRCLE_SHA1',
    runId: 'CIRCLE_BUILD_NUM',
    buildUrl: 'CIRCLE_BUILD_URL',
  },
  {
    name: 'Jenkins',
    docsUrl: 'https://www.jenkins.io/doc/book/security/environment-variables',
    detect: envAll('JENKINS_URL', 'BUILD_ID'),
    isPR: (env) => !!(env.ghprbPullId ?? env.CHANGE_ID),
    prNumber: (env) => parsePrNumber(env.ghprbPullId ?? env.CHANGE_ID),
  },
  {
    name: 'Railway',
    docsUrl: 'https://docs.railway.com/reference/variables',
    detect: envAny('RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID'),
    repo: (env) => {
      const owner = env.RAILWAY_GIT_REPO_OWNER;
      const name = env.RAILWAY_GIT_REPO_NAME;
      if (owner && name) return { owner, name };
      return undefined;
    },
    branch: 'RAILWAY_GIT_BRANCH',
    commitSha: 'RAILWAY_GIT_COMMIT_SHA',
    runId: 'RAILWAY_DEPLOYMENT_ID',
    buildUrl: (env) => (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined),
    environment: {
      var: 'RAILWAY_ENVIRONMENT_NAME',
      map: { production: 'production' },
    },
  },
  {
    name: 'Render',
    docsUrl: 'https://render.com/docs/environment-variables',
    detect: 'RENDER',
    isPR: (env) => env.IS_PULL_REQUEST === 'true',
    repo: (env) => parseRepoSlug(env.RENDER_GIT_REPO_SLUG),
    branch: 'RENDER_GIT_BRANCH',
    commitSha: 'RENDER_GIT_COMMIT',
  },
  {
    name: 'Travis CI',
    docsUrl: 'https://docs.travis-ci.com/user/environment-variables',
    detect: 'TRAVIS',
    isPR: (env) => env.TRAVIS_PULL_REQUEST !== undefined && env.TRAVIS_PULL_REQUEST !== 'false',
    prNumber: 'TRAVIS_PULL_REQUEST',
    repo: (env) => parseRepoSlug(env.TRAVIS_REPO_SLUG),
    branch: (env) => env.TRAVIS_BRANCH,
    commitSha: 'TRAVIS_COMMIT',
  },

  // Less common (alpha) ---
  {
    name: 'Agola CI',
    docsUrl: 'https://agola.io/doc/concepts/secrets_variables.html',
    detect: 'AGOLA_GIT_REF',
    isPR: 'AGOLA_PULL_REQUEST_ID',
    prNumber: 'AGOLA_PULL_REQUEST_ID',
  },
  { name: 'Alpic', detect: 'ALPIC_HOST' },
  {
    name: 'Appcircle',
    detect: 'AC_APPCIRCLE',
    isPR: (env) => env.AC_GIT_PR !== undefined && env.AC_GIT_PR !== 'false',
    prNumber: 'AC_GIT_PR',
  },
  {
    name: 'AppVeyor',
    docsUrl: 'https://www.appveyor.com/docs/environment-variables',
    detect: 'APPVEYOR',
    isPR: 'APPVEYOR_PULL_REQUEST_NUMBER',
    prNumber: 'APPVEYOR_PULL_REQUEST_NUMBER',
    repo: (env) => parseRepoSlug(env.APPVEYOR_REPO_NAME),
    branch: 'APPVEYOR_REPO_BRANCH',
    commitSha: 'APPVEYOR_REPO_COMMIT',
  },
  { name: 'Bamboo', detect: 'bamboo_planKey' },
  {
    name: 'Bitrise',
    docsUrl: 'https://docs.bitrise.io/en/bitrise-ci/references/available-environment-variables.html',
    detect: 'BITRISE_IO',
    isPR: 'BITRISE_PULL_REQUEST',
    prNumber: 'BITRISE_PULL_REQUEST',
    repo: (env) => {
      const owner = env.BITRISEIO_GIT_REPOSITORY_OWNER;
      const name = env.BITRISEIO_GIT_REPOSITORY_SLUG;
      return owner && name ? { owner, name } : undefined;
    },
    branch: 'BITRISE_GIT_BRANCH',
    commitSha: 'BITRISE_GIT_COMMIT',
  },
  {
    name: 'Buddy',
    detect: 'BUDDY_WORKSPACE_ID',
    isPR: 'BUDDY_EXECUTION_PULL_REQUEST_ID',
    prNumber: 'BUDDY_EXECUTION_PULL_REQUEST_ID',
  },
  {
    name: 'Cirrus CI',
    docsUrl: 'https://cirrus-ci.org/guide/writing-tasks',
    detect: 'CIRRUS_CI',
    isPR: 'CIRRUS_PR',
    prNumber: 'CIRRUS_PR',
    repo: (env) => parseRepoSlug(env.CIRRUS_REPO_FULL_NAME),
    branch: 'CIRRUS_BRANCH',
    commitSha: 'CIRRUS_CHANGE_IN_REPO',
  },
  {
    name: 'Codefresh',
    docsUrl: 'https://codefresh.io/docs/docs/pipelines/variables',
    detect: 'CF_BUILD_ID',
    isPR: (env) => !!(env.CF_PULL_REQUEST_NUMBER ?? env.CF_PULL_REQUEST_ID),
    prNumber: (env) => parsePrNumber(env.CF_PULL_REQUEST_NUMBER ?? env.CF_PULL_REQUEST_ID),
    branch: 'CF_BRANCH',
    commitSha: 'CF_REVISION',
  },
  { name: 'Codemagic', detect: 'CM_BUILD_ID', prNumber: 'CM_PULL_REQUEST' },
  { name: 'Codeship', detect: (env) => env.CI_NAME === 'codeship' },
  {
    name: 'Deno Deploy',
    docsUrl: 'https://docs.deno.com/deploy/early-access/reference/env-vars-and-contexts',
    detect: envAny('DENO_DEPLOY', 'DENO_DEPLOYMENT_ID'),
    runId: (env) => env.DENO_DEPLOY_BUILD_ID ?? env.DENO_DEPLOYMENT_ID,
  },
  {
    name: 'Drone',
    docsUrl: 'https://docs.drone.io/pipeline/environment/reference',
    detect: 'DRONE',
    isPR: (env) => env.DRONE_BUILD_EVENT === 'pull_request',
    prNumber: 'DRONE_PULL_REQUEST',
    repo: (env) => {
      const full = env.DRONE_REPO;
      if (full) return parseRepoSlug(full);
      const owner = env.DRONE_REPO_OWNER;
      const name = env.DRONE_REPO_NAME;
      if (owner && name) return { owner, name };
      return undefined;
    },
    branch: 'DRONE_COMMIT_BRANCH',
    commitSha: 'DRONE_COMMIT_SHA',
  },
  { name: 'dsari', detect: 'DSARI' },
  { name: 'Earthly', detect: 'EARTHLY_CI' },
  {
    name: 'Expo Application Services',
    docsUrl: 'https://docs.expo.dev/build-reference/variables',
    detect: 'EAS_BUILD',
    commitSha: 'EAS_BUILD_GIT_COMMIT_HASH',
  },
  { name: 'Firebase App Hosting', docsUrl: 'https://firebase.google.com/docs/app-hosting/configure', detect: 'FIREBASE_APP_HOSTING' },
  { name: 'Gerrit', detect: 'GERRIT_PROJECT' },
  { name: 'Gitea Actions', detect: 'GITEA_ACTIONS' },
  { name: 'GoCD', detect: 'GO_PIPELINE_LABEL' },
  { name: 'Google Cloud Build', detect: 'BUILDER_OUTPUT' }, // not actually set by default, user has to set it within their yaml config
  {
    name: 'Google Cloud Run',
    docsUrl: 'https://cloud.google.com/run/docs/container-contract',
    // Cloud Run doesn't inject git metadata; only available if wired up manually via Cloud Build substitutions
    detect: envAny('K_SERVICE', 'CLOUD_RUN_JOB'),
    runId: (env) => env.K_REVISION ?? env.CLOUD_RUN_EXECUTION,
  },
  { name: 'Heroku', detect: (env) => (env.NODE ?? '').includes('/app/.heroku/node/bin/node') },
  { name: 'Hudson', detect: 'HUDSON_URL' },
  {
    name: 'LayerCI',
    detect: 'LAYERCI',
    isPR: 'LAYERCI_PULL_REQUEST',
    prNumber: 'LAYERCI_PULL_REQUEST',
  },
  { name: 'Magnum CI', detect: 'MAGNUM' },
  {
    name: 'Nevercode',
    detect: 'NEVERCODE',
    isPR: (env) => env.NEVERCODE_PULL_REQUEST !== undefined && env.NEVERCODE_PULL_REQUEST !== 'false',
    prNumber: 'NEVERCODE_PULL_REQUEST',
  },
  { name: 'Prow', detect: 'PROW_JOB_ID' },
  { name: 'ReleaseHub', detect: 'RELEASE_BUILD_ID' },
  {
    name: 'Sail CI',
    detect: 'SAILCI',
    isPR: 'SAIL_PULL_REQUEST_NUMBER',
    prNumber: 'SAIL_PULL_REQUEST_NUMBER',
  },
  {
    name: 'Screwdriver',
    detect: 'SCREWDRIVER',
    isPR: (env) => env.SD_PULL_REQUEST !== undefined && env.SD_PULL_REQUEST !== 'false',
    prNumber: 'SD_PULL_REQUEST',
  },
  {
    name: 'Semaphore',
    docsUrl: 'https://docs.semaphore.io/reference/env-vars/',
    detect: 'SEMAPHORE',
    isPR: 'SEMAPHORE_GIT_PR_NUMBER',
    prNumber: 'SEMAPHORE_GIT_PR_NUMBER',
    repo: (env) => parseRepoSlug(env.SEMAPHORE_GIT_REPO_SLUG),
    branch: 'SEMAPHORE_GIT_BRANCH',
    commitSha: 'SEMAPHORE_GIT_SHA',
  },
  { name: 'Sourcehut', detect: (env) => env.CI_NAME === 'sourcehut' },
  { name: 'Strider CD', detect: 'STRIDER' },
  { name: 'TaskCluster', detect: envAny('TASK_ID', 'RUN_ID') },
  {
    name: 'TeamCity',
    docsUrl: 'https://www.jetbrains.com/help/teamcity/predefined-build-parameters.html',
    detect: 'TEAMCITY_VERSION',
  },
  {
    name: 'Vela',
    detect: 'VELA',
    isPR: (env) => env.VELA_PULL_REQUEST === '1',
    prNumber: 'VELA_PULL_REQUEST',
  },
  { name: 'Visual Studio App Center', detect: 'APPCENTER_BUILD_ID' },
  {
    name: 'Woodpecker',
    docsUrl: 'https://woodpecker-ci.org/docs/usage/environment',
    detect: envEq('CI', 'woodpecker'),
    isPR: (env) => env.CI_BUILD_EVENT === 'pull_request',
    repo: (env) => parseRepoSlug(env.CI_REPO),
    branch: 'CI_COMMIT_BRANCH',
    prNumber: (env) => parsePrNumber(env.CI_COMMIT_PULL_REQUEST),
    commitSha: 'CI_COMMIT_SHA',
  },
  { name: 'Xcode Cloud', detect: 'CI_XCODE_PROJECT', prNumber: 'CI_PULL_REQUEST_NUMBER' },
  { name: 'Xcode Server', detect: 'XCS' },
  {
    name: 'Zeabur',
    docsUrl: 'https://zeabur.com/docs/en-US/deploy/variables',
    detect: envAny('ZEABUR_SERVICE_ID', 'ZEABUR_PROJECT_ID', 'ZEABUR_ENVIRONMENT_ID'),
    repo: (env) => {
      const owner = env.ZEABUR_GIT_REPO_OWNER;
      const name = env.ZEABUR_GIT_REPO_NAME;
      if (owner && name) return { owner, name };
      return undefined;
    },
    branch: 'ZEABUR_GIT_BRANCH',
    commitSha: 'ZEABUR_GIT_COMMIT_SHA',
  },

  // Dev sandboxes (alpha) — interactive environments, not a CI pipeline ---
  {
    name: 'CodeSandbox',
    docsUrl: 'https://codesandbox.io/docs/learn/environment/configuration',
    detect: envAny('CODESANDBOX_SSE', 'CODESANDBOX_HOST'),
    ci: false,
  },
  {
    name: 'GitHub Codespaces',
    docsUrl: 'https://docs.github.com/en/codespaces/reference/system-environment-variables-for-codespaces',
    detect: 'CODESPACES',
    repo: (env) => parseRepoSlug(env.GITHUB_REPOSITORY),
    ci: false,
  },
  {
    name: 'Gitpod',
    docsUrl: 'https://www.gitpod.io/docs/references/gitpod-environment-variables',
    detect: 'GITPOD_WORKSPACE_ID',
    ci: false,
  },
  {
    name: 'Replit',
    docsUrl: 'https://docs.replit.com/replit-workspace/dependencies/environment-variables',
    detect: envAny('REPL_ID', 'REPLIT_DB_URL'),
    ci: false,
  },
  {
    name: 'StackBlitz',
    docsUrl: 'https://developer.stackblitz.com/guides/user-guide/environment-variables',
    // WebContainers don't set a dedicated env var; this is the same best-effort signal std-env uses
    detect: (env) => env.SHELL === '/bin/jsh',
    ci: false,
  },
];
