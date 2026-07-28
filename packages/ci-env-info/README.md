# @varlock/ci-env-info

Detect the current CI/deploy platform and expose normalized metadata: repo, branch, PR number, commit SHA, build URL, deployment environment, and more.

This package powers the `VARLOCK_*` builtin variables in [Varlock](https://varlock.dev). It can also be used standalone.

## Usage

```ts
import { getCiEnvFromProcess, getCiEnv } from '@varlock/ci-env-info';

// Use current process.env
const info = getCiEnvFromProcess();
if (info.isCI) {
  console.log('Platform:', info.name);
  console.log('Repo:', info.fullRepoName);
  console.log('Branch:', info.branch);
  console.log('Commit:', info.commitShaShort);
  console.log('Environment:', info.environment);
}

// Or pass an env record (useful for testing)
const info2 = getCiEnv({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo' });
```

## API

- **`getCiEnv(env: EnvRecord): CiEnvInfo`** – Returns CI environment info from the given env record.
- **`getCiEnvFromProcess(): CiEnvInfo`** – Convenience wrapper: calls `getCiEnv(process.env)`.
- **`EnvRecord`** – `Record<string, string | undefined>`.
- **`CiEnvInfo`** – `isCI`, `name`, `docsUrl`, `isPR`, `repo`, `fullRepoName`, `branch`, `prNumber`, `commitSha`, `commitShaShort`, `environment`, `runId`, `buildUrl`, `workflowName`, `actor`, `eventName`, `raw`.
- **`DeploymentEnvironment`** – `'development' | 'preview' | 'staging' | 'production' | 'test'`.
- **`detectRuntime(globalObj?): RuntimeInfo`** – Detects the current JS runtime (`node`, `deno`, `bun`, `workerd`, `fastly`, `netlify`, `edge-light`, `browser`). Reads ambient globals, not env vars; pass a custom object for testing.
- **`detectOs(processObj?): OsInfo`** – Detects the OS (`darwin`, `win32`, `linux`) from `process.platform`.

## Supported platforms

GitHub Actions, GitLab CI, Vercel, Netlify, Cloudflare Pages, Cloudflare Workers, AWS Amplify, AWS CodeBuild, Azure Pipelines, Bitbucket Pipelines, Buildkite, CircleCI, Jenkins, Railway, Render, Travis CI, Google Cloud Run, Deno Deploy, Zeabur, Firebase App Hosting, and many more.

Also detects interactive dev sandboxes (CodeSandbox, StackBlitz, GitHub Codespaces, Gitpod, Replit) with `isCI: false`, since they aren't a CI pipeline but are still useful to identify.

Platforms are defined in TypeScript with no external dependencies. Detection uses environment variables specific to each platform.

## Learn more

Check out the [Varlock docs](https://varlock.dev) for more about how this fits into env var management.
