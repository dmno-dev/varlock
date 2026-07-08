---
"@varlock/ci-env-info": minor
varlock: minor
---

Add detection for Railway, AWS Amplify, Google Cloud Run, Deno Deploy, Zeabur, and Firebase App Hosting; detect dev sandboxes (CodeSandbox, StackBlitz, GitHub Codespaces, Gitpod, Replit) with isCI: false; add detectRuntime/detectOs and expose them as VARLOCK_RUNTIME/VARLOCK_OS builtin variables.

Also fixes several incorrect env var names found during a std-env doc audit: GitHub Actions PR number (was reading a non-existent variable), GitLab MR number (was using the instance-wide ID instead of the IID), Netlify build URL (double `https://`), Semaphore PR number (Classic-only variable), Azure Pipelines PR number (prefers the GitHub-facing number), and Bitbucket repo owner (deprecated variable). Adds repo extraction for Bitrise.
