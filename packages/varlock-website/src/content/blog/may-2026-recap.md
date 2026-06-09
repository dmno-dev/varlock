---
title: "May 2026 Recap"
description: "OIDC workload identity lands across secret provider plugins, varlock audit helps keep code and schema in sync, agent-friendly CLI workflows ship, and the community showed up at Web Summit Vancouver, Toronto Tech Week, and on podcasts."
date: 2026-06-01
image: ../../assets/blog/may-2026-recap.jpeg
authors:
  - name: "Varlock Team"
---

May kept the momentum going: OIDC workload identity federation shipped across secret provider plugins, [`varlock@1.4.0`](/reference/cli-commands/) added audit tooling and agent-friendly workflows, and we had a great time meeting folks at **Web Summit Vancouver** and **Toronto Tech Week**.

## 🔧 Core Improvements

May included four core releases — [`varlock@1.1.0`](/reference/cli-commands/) through [`varlock@1.4.0`](/reference/cli-commands/) — with a strong focus on CI/deploy auth, schema hygiene, and AI/agent ergonomics.

### OIDC workload identity

Secret provider plugins now support [OIDC workload identity federation](/guides/oidc/): Varlock auto-detects short-lived OIDC tokens from platforms like Vercel, GitHub Actions, GitLab CI, and Fly.io, then exchanges them for temporary credentials with AWS, Azure, Google Secret Manager, HashiCorp Vault, Infisical, and Akeyless. No long-lived “secret zero” needed to fetch the rest of your secrets.

### Audit and schema hygiene

- **`varlock audit`** - New code env scanner and audit command to find schema items missing from application code (and vice versa). See [`varlock audit`](/reference/cli-commands/#audit), [`@auditIgnore`](/reference/item-decorators/#auditignore), and [`@auditIgnorePaths()`](/reference/root-decorators/#auditignorepaths). Thanks [@danish-fareed](https://github.com/danish-fareed).
- **`@deprecated` item decorator** - Mark variables as deprecated with strikethrough in pretty output and `@deprecated` JSDoc in generated types. ([PR #644](https://github.com/dmno-dev/varlock/pull/644))
- **Load summaries for automation** - `--summary-stderr` / `--summary-file` on `varlock load`, plus `fullResult` on `execSyncVarlock` for programmatic consumers. ([PR #681](https://github.com/dmno-dev/varlock/pull/681))

### Agent and DX improvements

- **`--agent` flag** - Non-interactive `varlock init` and `varlock load` for AI coding assistants and automation. See the [AI tools guide](/guides/ai-tools/).
- **Shell tab completion** - `varlock complete` for bash, zsh, and fish. See the [shell completion guide](/guides/shell-completion/).
- **Varlock agent skill** - Installable via `npx skills add dmno-dev/varlock` for Cursor and other agent harnesses. ([PR #719](https://github.com/dmno-dev/varlock/pull/719))
- **Unified error handling** - Severity levels across load failures, with plugin loading errors surfaced in `DataSource.errors`. ([PR #708](https://github.com/dmno-dev/varlock/pull/708))
- **Vite dev error UX** - Styled HTML error pages when `varlock load` fails in dev mode, with partial env data available on failure.

### Fixes and reliability

- **Biometric / keychain sessions** - Better session scoping for non-TTY agents (Codex and similar) to avoid repeated Touch ID prompts. ([PR #675](https://github.com/dmno-dev/varlock/pull/675), [PR #718](https://github.com/dmno-dev/varlock/pull/718))
- **WSL hardening** - Fixed `varlock encrypt` on WSL and standalone binary edge cases. ([PR #679](https://github.com/dmno-dev/varlock/pull/679), [PR #711](https://github.com/dmno-dev/varlock/pull/711))
- **Decorator parsing** - Stray text on decorator lines no longer causes silently ignored decorators. ([PR #724](https://github.com/dmno-dev/varlock/pull/724))

## 🔌 Integrations and Plugins

May shipped coordinated `1.1.x` releases across the ecosystem, with OIDC support landing in cloud secret manager plugins:

- **[`@varlock/aws-secrets-plugin`](/plugins/aws-secrets/)**, **[`@varlock/azure-key-vault-plugin`](/plugins/azure-key-vault/)**, **[`@varlock/google-secret-manager-plugin`](/plugins/google-secret-manager/)**, **[`@varlock/hashicorp-vault-plugin`](/plugins/hashicorp-vault/)**, **[`@varlock/infisical-plugin`](/plugins/infisical/)**, **[`@varlock/akeyless-plugin`](/plugins/akeyless/)** - OIDC workload identity federation support.
- **[`@varlock/1password-plugin`](/plugins/1password/)** - Added `useCliWithServiceAccount` for memory-constrained headless environments that prefer the `op` CLI over the WASM SDK. ([PR #692](https://github.com/dmno-dev/varlock/pull/692))
- **[`@varlock/cloudflare-integration`](/integrations/cloudflare/)** - TanStack Start + Vite 6/7/8 compatibility, `varlock-wrangler` fixes for `versions upload`, styled dev error pages, and clearer env reload feedback when watched files change but resolved env does not.
- **[`@varlock/nextjs-integration`](/integrations/nextjs/)** and **[`@varlock/vite-integration`](/integrations/vite/)** - Improved env reload feedback and graceful partial-load behavior on validation failures.
- **[`env-spec-language`](/env-spec/vs-code-ext/)** and **[`@env-spec/parser`](https://github.com/dmno-dev/varlock/releases/tag/%40env-spec/parser%400.3.3)** - Parser and editor tooling updates alongside core releases.

## 🌐 Content Highlights

Community energy was strong this month across events, podcasts, and video:

- **[Software Defined Talk Episode 571: The Enterprise Dunbar number](https://www.softwaredefinedtalk.com/571)** - Listener JD gave Varlock a shout-out (~47:00). And then Brandon gives Varlock an official shout-out in episode [#573](https://www.softwaredefinedtalk.com/573). Thank you JD and Brandon!
- **[I Deployed to Vercel and Only Set One Secret — varlock Did the Rest](https://www.youtube.com/watch?v=7n3itBlEkSM)** - Thiago Temple walks through a Vercel deploy using Varlock, SvelteKit, and 1Password
- **Community-built Zed extension** - [Peter Cruckshank](https://x.com/PeteCapeCod) shared a [Zed editor extension](https://github.com/petercr/varlock-zed-extension) for `.env.schema` highlighting and autocomplete: [tweet](https://x.com/PeteCapeCod/status/2057170886155792547). Peter said he will open a PR into the main repo so we can make this a first-party extension in the future. 

## 💬 Community

We're always looking for feedback and ideas. Join our community:

- [Discord](https://chat.dmno.dev) - Chat with us and other users.
- [GitHub Discussions](https://github.com/dmno-dev/varlock/discussions) - Suggestions, questions, and feature ideas.
- [GitHub](https://github.com/dmno-dev/varlock) - Star the project and follow updates.
- [X](https://x.com/varlockdev) - Follow us on X.
- [Bluesky](https://bsky.app/profile/varlock.dev) - Follow us on Bluesky.
