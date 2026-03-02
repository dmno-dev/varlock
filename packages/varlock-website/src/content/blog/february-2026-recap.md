---
title: "February 2026 Recap"
description: "varlock@0.2.0 lands with multi-line syntax and new decorators, four cloud secret manager plugins launch, and we share our GitHub Secure Open Source Fund experience."
date: 2026-03-02
image: ../../assets/blog/february-2026-recap.jpeg
authors:
  - name: "Varlock Team"
---

February was a big month: we shipped varlock 0.2.0 with lots of improvements, launched four new secret manager plugins, and announced our participation in the [GitHub Secure Open Source Fund](https://varlock.dev/blog/github-secure-open-source-fund).

## Major Release: varlock@0.2.0

**[`varlock@0.2.0`](https://github.com/dmno-dev/varlock/releases/tag/varlock%400.2.0)** introduced several core improvements:

- **Multi-line function calls** — Both decorators and item values now support multi-line syntax, making complex configs easier to read and maintain.
- **Conditional `@import`** — The `enabled` parameter lets you conditionally load env files (e.g. by environment or feature flags).
- **`@public` decorator** — New counterpart to `@sensitive` for explicitly marking values as safe to log or expose.
- **`--compact` flag** — For `varlock load`, outputs a compact format suitable for scripts and CI.
- **Import from `~`** — You can now reference home directory paths in imports.
- **`allowMissing` on `@import`** — Lets imports optionally succeed when the target file doesn't exist.
- **Package manager detection** — Better handling when multiple lockfiles (e.g. npm + Bun) are present; no more crashes in monorepos.
- **Improved CLI help** — All commands now have clearer examples and usage guidance.

## Other Releases

- **[`varlock@0.2.1`](https://github.com/dmno-dev/varlock/releases/tag/varlock%400.2.1)**: Added `--path` / `-p` to `load` and `run` so you can specify a `.env` file or directory as the entry point.
- **[`varlock@0.1.6`](https://github.com/dmno-dev/varlock/releases/tag/varlock%400.1.6)**: Added `--no-redact-stdout` flag to `varlock run` for cases where you need unredacted output (e.g., running Claude interactively).

## New Secret Manager Plugins

We launched four new plugins, broadening support for popular secret managers:

- **[`@varlock/aws-secrets-plugin`](/plugins/aws-secrets/)** — AWS Secrets Manager and Systems Manager Parameter Store
- **[`@varlock/azure-key-vault-plugin`](/plugins/azure-key-vault/)** — Azure Key Vault
- **[`@varlock/bitwarden-plugin`](/plugins/bitwarden/)** — Bitwarden
- **[`@varlock/infisical-plugin`](/plugins/infisical/)** — Infisical

## GitHub Secure Open Source Fund

We published [How Varlock Is Leveling Up Security Through the GitHub Secure Open Source Fund](https://varlock.dev/blog/github-secure-open-source-fund), sharing what we learned from participating in the program. 

## Community

We're always looking for feedback and ideas. Join the conversation:

- [Discord](https://chat.dmno.dev) — Chat with us and other users.
- [GitHub Discussions](https://github.com/dmno-dev/varlock/discussions) — Suggestions, questions, and feature ideas.
