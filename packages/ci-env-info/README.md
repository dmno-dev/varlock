# @varlock/ci-env-info

Detect the current CI environment and expose normalized fields: repo (owner/name), branch, PR number, commit SHA, and deployment environment (development / preview / staging / production).

## Usage

```ts
import { getCiEnvFromProcess, getCiEnv } from '@varlock/ci-env';

// Use current process.env
const info = getCiEnvFromProcess();
if (info.isCI) {
  console.log('Platform:', info.name);
  console.log('Repo:', info.fullRepoName);
  console.log('Branch:', info.branch);
  console.log('Docs:', info.docsUrl);
}

// Or pass an env record (e.g. for tests)
const info2 = getCiEnv({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo' });
```

## API

- **`getCiEnv(env: EnvRecord): CiEnvInfo`** – Core: returns CI environment info from the given env record.
- **`getCiEnvFromProcess(): CiEnvInfo`** – Convenience: same as `getCiEnv(process.env)`.
- **`EnvRecord`** – `Record<string, string | undefined>` (env-like object).
- **`CiEnvInfo`** – `isCI`, `name`, `docsUrl`, `isPR`, `repo`, `fullRepoName`, `branch`, `prNumber`, `commitSha`, `commitShaShort`, `environment`, `raw`.

Platforms are defined in TypeScript (no external ci-info dependency); detection and extractors can be a simple env var name (string) or a function for custom logic.
