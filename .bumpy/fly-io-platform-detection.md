---
"@varlock/ci-env-info": patch
varlock: patch
---

Detect Fly.io as a platform (`VARLOCK_PLATFORM=Fly.io`), and warn when `VARLOCK_ENV` is used but only guessed `preview` because the platform reports no environment or branch
