---
"varlock": minor
---

Add `varlock scan` command to detect leaked secrets in project files, with `--install-hook` flag to set up a git pre-commit hook. Automatically detects package manager (npm, pnpm, bun, etc.) and hook managers (husky, lefthook, simple-git-hooks) for correct setup.
