---
title: "April 2026 Recap"
description: "Varlock shipped local encryption and lock/reveal workflows, major integration and plugin updates landed, and our first Varlock SideQuest — bumpy — went public."
date: 2026-05-01
image: ../../assets/blog/april-2026-recap.jpeg
authors:
  - name: "Varlock Team"
---

April was a big month for Varlock: local encryption landed, integrations and plugins saw meaningful updates, and we shipped our first **Varlock SideQuest** — [bumpy](https://github.com/dmno-dev/bumpy).

## 🔧 Core Improvements

April's biggest core drop was [`varlock@1.0.0`](/reference/cli-commands/), with stronger config behavior guarantees and broader stability work across the stack.

## 🫆 Local encryption

- **Built-in local encryption utilities** - Added a built-in `varlock()` resolver for local device-bound encryption on MacOS, Windows (Native and WSL), and Linux.
- **New CLI encryption workflow** - Added `varlock encrypt` (with stdin support), `varlock reveal`, and `varlock lock` commands.
- **Built-in Keychain support (macOS)** - Added `keychain()` resolver support for macOS workflows.

## 🐸 Varlock SideQuest: bumpy

_**SideQuest** is our label for sibling projects that extend the Varlock universe without living inside the core repo._
 
 [bumpy](https://github.com/dmno-dev/bumpy) is the first: **modern monorepo-friendly version management and changelog tooling** built as a successor to the changesets workflow (bump files, consolidated releases, changelog generation), with a different engine tuned for workspace protocols, dependency propagation, and CI without an extra app or action.

 We're already using bumpy to manage the Varlock monorepo and we're excited to see it grow into a community-driven tool. 

## 🔌 Integrations and Plugins

April shipped substantive updates across integrations and tooling:

- **[`@varlock/astro-integration`](/integrations/astro/)** - Added post-build leak detection for static HTML output and expanded framework test coverage across Astro v5/v6.
- **[`@varlock/vite-integration`](/integrations/vite/)** - Improved invalid-config behavior: better partial JSON output from `varlock load --format json-full`, safer dev-mode handling, and clearer build-time error details.
- **[`@varlock/nextjs-integration`](/integrations/nextjs/)** - Fixed duplicate-import/diamond-dependency behavior to prevent duplicate plugin initialization and preserve import precedence.
- **[`@varlock/cloudflare-integration`](/integrations/cloudflare/)** - Introduced SvelteKit + Cloudflare Workers support via `varlockSvelteKitCloudflarePlugin`, plus guardrails against conflicting plugin registration.
- **[`@varlock/1password-plugin`](/plugins/1password/)** - Added self-hosted 1Password Connect support (`connectHost`/`connectToken`) and improved Connect-specific resolver/error handling.
- **[`env-spec-language`](/env-spec/vs-code-ext/)** and **[`@env-spec/parser`](https://github.com/dmno-dev/varlock/releases/tag/%40env-spec/parser%400.3.1)** - Improved regex/path parsing behavior and diagnostics around decorators and completions.

Many other integrations/plugins also received April stability releases alongside these feature-focused updates.

### Fixes and Reliability

- **Decorator precedence** - Explicit per-item decorators now correctly take priority over `@defaultSensitive`/`@defaultRequired` from other files. ([PR #666](https://github.com/dmno-dev/varlock/pull/666))
- **`varlock run` and sensitive graphs** - Added `--no-inject-graph` to avoid putting the serialized config graph (`__VARLOCK_ENV`) in the child process environment when you need stricter secrecy (interactive shells, long-lived workers, agents). ([PR #615](https://github.com/dmno-dev/varlock/pull/615))
- **Leak scanning** - Leak detection now covers binary bodies (`Uint8Array` / `ArrayBuffer`), which matters for runtimes like Cloudflare Workers where secrets sometimes move as bytes. ([PR #622](https://github.com/dmno-dev/varlock/pull/622))
- **Language + tooling edge cases** - Fixed path-vs-regex ambiguity (POSIX paths mistaken for `/pattern/` regex), tightened `noTrailingSlash` validation for URLs, and improved generated TypeScript when descriptions contain awkward `*/` sequences. ([PR #620](https://github.com/dmno-dev/varlock/pull/620), [PR #610](https://github.com/dmno-dev/varlock/pull/610), [PR #627](https://github.com/dmno-dev/varlock/pull/627))
- **Windows hardening** - Fixed `varlock run` spawning for `.cmd`/`.bat`, Pathext-aware resolution (`pnpm`/tsx-style shims), and `pnpm` binary detection (`varlock.cmd`). ([PR #618](https://github.com/dmno-dev/varlock/pull/618), [PR #590](https://github.com/dmno-dev/varlock/pull/590))
- **Built-in typings and DX** - `VARLOCK_IS_CI` is now a real `boolean`; `declare module 'varlock/env'` no longer collides across multiple packages’ generated `env.d.ts`. ([PR #583](https://github.com/dmno-dev/varlock/pull/583), [PR #594](https://github.com/dmno-dev/varlock/pull/594))
- **`varlock init`** - No longer crashes on Linux when `git` isn’t installed; terminal colors behave better under redaction via `FORCE_COLOR` when stdout is piped behind Varlock. ([PR #581](https://github.com/dmno-dev/varlock/pull/581), [PR #575](https://github.com/dmno-dev/varlock/pull/575))

Earlier in April, CLI and tooling work also landed [**partial `json-full` loads on validation failure**](https://github.com/dmno-dev/varlock/pull/527), [**multiple `--path` flags**](https://github.com/dmno-dev/varlock/pull/593), [**multi-entry `package.json` `loadPath`**](https://github.com/dmno-dev/varlock/pull/571), [**`varlock explain` plus clearer override indicators in `varlock load`**](https://github.com/dmno-dev/varlock/pull/560), [**third‑party plugins**](https://github.com/dmno-dev/varlock/pull/538) with trust rules keyed to JS installs vs standalone binary, [**standalone-vs-`node_modules` version mismatch warnings**](https://github.com/dmno-dev/varlock/pull/534), plus [**Vitest `projects` / monorepo root resolution**](https://github.com/dmno-dev/varlock/pull/542), [**`.git` + lockfile root detection**](https://github.com/dmno-dev/varlock/pull/558), [**binary resolution when `cwd` ≠ package root**](https://github.com/dmno-dev/varlock/pull/547), and [**diamond dependency / duplicate schema imports**](https://github.com/dmno-dev/varlock/pull/553).

## 🌐 Content Highlights

A few highlights from around the ecosystem this month:

- **Operation Varlock demo project** - a game/security-focused community project exploring prompt-injection simulation with Varlock concepts: [operation-varlock](https://github.com/harishkotra/operation-varlock).
- **Q1 momentum recognition** - DMNO/Varlock was highlighted in OSSCAR's Q1 2026 scaling rankings as one of the fastest growing open source orgs on GitHub: [OSSCAR - DMNO](https://osscar.dev/org/dmno-dev).

## 💬 Community

April discussions helped surface practical DX improvements and edge cases:

- [Internal variables](https://github.com/dmno-dev/varlock/discussions/549)
- [How to conditionally set env var?](https://github.com/dmno-dev/varlock/discussions/573)
- [InitVarlockEnv failed on vite & cloudflare integration](https://github.com/dmno-dev/varlock/discussions/611)
- [Add `@deprecated` decorator](https://github.com/dmno-dev/varlock/discussions/642)

We're always looking for feedback and ideas. Join our community:

- [Discord](https://chat.dmno.dev) - Chat with us and other users.
- [GitHub Discussions](https://github.com/dmno-dev/varlock/discussions) - Suggestions, questions, and feature ideas.
- [GitHub](https://github.com/dmno-dev/varlock) - Star the project and follow updates.
- [X](https://x.com/varlockdev) - Follow us on X.
- [Bluesky](https://bsky.app/profile/varlock.dev) - Follow us on Bluesky.
