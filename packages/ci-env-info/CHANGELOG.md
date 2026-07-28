# @varlock/ci-env-info


## 0.1.0
<sub>2026-07-15</sub>

- [#871](https://github.com/dmno-dev/varlock/pull/871)  *(minor)*
  Add detection for Railway, AWS Amplify, Google Cloud Run, Deno Deploy, Zeabur, and Firebase App Hosting; detect dev sandboxes (CodeSandbox, StackBlitz, GitHub Codespaces, Gitpod, Replit) with isCI: false; add detectRuntime/detectOs and expose them as VARLOCK_RUNTIME/VARLOCK_OS builtin variables.

  Also fixes several incorrect env var names found during a std-env doc audit: GitHub Actions PR number (was reading a non-existent variable), GitLab MR number (was using the instance-wide ID instead of the IID), Netlify build URL (double `https://`), Semaphore PR number (Classic-only variable), Azure Pipelines PR number (prefers the GitHub-facing number), and Bitbucket repo owner (deprecated variable). Adds repo extraction for Bitrise.

  A second pass against std-env's actual detection logic found three more real gaps: Vercel and Netlify now report `isCI: false` when running their local dev servers (`vercel dev`, `netlify dev`) instead of always reporting CI; StackBlitz detection now also requires the WebContainer runtime marker (matching std-env) instead of a weak SHELL-only heuristic that could misfire; and `detectRuntime`'s `isNode` flag now matches std-env's semantics (stays `true` under Bun/Deno's Node-compat mode).

## 0.0.2

### Patch Changes

- [#566](https://github.com/dmno-dev/varlock/pull/566) [`012ed3f`](https://github.com/dmno-dev/varlock/commit/012ed3fd8a290572872200cb8d73a56616e9047d) - Fix `VARLOCK_BRANCH` returning `refs/pull/123/merge` in GitHub Actions PR workflows.

  In GitHub Actions pull request contexts, `GITHUB_REF` is set to the merge ref (e.g. `refs/pull/123/merge`) rather than the branch name. GitHub Actions also provides `GITHUB_HEAD_REF` which contains the actual PR head branch name (e.g. `feat-init-infra`).

  Changes:

  - Updated GitHub Actions platform branch extractor to prefer `GITHUB_HEAD_REF` when available, falling back to `refToBranch(GITHUB_REF)` for non-PR contexts
  - Fixed `refToBranch()` to return `undefined` for `refs/pull/` refs instead of returning the raw merge ref string

## 0.0.1

### Patch Changes

- [#285](https://github.com/dmno-dev/varlock/pull/285) [`2d15354`](https://github.com/dmno-dev/varlock/commit/2d153547a08cc9b23e85d6e66a4b557222c9c206) - new auto-inferred VARLOCK_ENV from ci info (uses new ci-env-info package)
