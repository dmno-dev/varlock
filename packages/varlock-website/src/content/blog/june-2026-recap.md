---
title: "June 2026 Recap"
description: "Varlock gains encrypted deployment controls, a full caching system, and @internal secret-zero hygiene; a new Kubernetes plugin ships; secret provider plugins hit 2.0; and fledgling joins the SideQuest lineup."
date: 2026-07-01
image: ../../assets/blog/june-2026-recap.jpeg
authors:
  - name: "Varlock Team"
---

June was packed: [`varlock@1.5.0`](/reference/cli-commands/) through [`varlock@1.9.0`](/reference/cli-commands/) landed encrypted deployment controls, a full caching system, and smarter schema imports; secret provider plugins adopted [`@internal`](/reference/item-decorators/#internal) credentials by default; and community contributor [@idorozin](https://github.com/idorozin) shipped a new Kubernetes plugin.

## 🔧 Core Improvements

June releases were focused on deployment security, caching, schema ergonomics, and container-friendly `varlock run` behavior.

### Encrypted deployments

- **`@encryptInjectedEnv` and `@disableProcessEnvInjection`** - Root decorators for encrypting the injected env blob at build time and optionally keeping plaintext secrets out of `process.env` entirely. See the [encrypted deployments guide](/guides/encrypted-deployments/) and [`@encryptInjectedEnv`](/reference/root-decorators/#encryptinjectedenv) / [`@disableProcessEnvInjection`](/reference/root-decorators/#disableprocessenvinjection) reference docs.

### Caching, durations, and random generators

- **Built-in caching system** - `cache()` resolver, plugin cache API, encrypted on-disk store, and `varlock cache` CLI (`status` / `clear`). See the [caching guide](/guides/caching/) and [`varlock cache`](/reference/cli-commands/#cache).
- **`duration` data type** - Shared TTL parser for `cache()` and plugin `cacheTtl` options. See the [`duration` data type](/reference/data-types/#duration).
- **Random value generators** - `randomNum()`, `randomUuid()`, `randomHex()`, and `randomString()` backed by `node:crypto`. See [random value generators](/reference/functions/#random-value-generators).
- **CI disk caching** - Set `_VARLOCK_CACHE_KEY` to share an encrypted disk cache across CI processes without persisting the key to disk.

### Schema and import ergonomics

- **`pick` / `omit` filters** - `@setValuesBulk()` and [`@import()`](/reference/root-decorators/#import) now support allowlist/denylist key filters with glob support.
- **Object and array literals** - Standalone `{key=value}` and `[a, b, c]` literals in the env-spec grammar, including multi-line forms with `#` comments. VS Code extension syntax highlighting updated alongside parser releases.
- **Per-item leak-detection opt-out** - `@sensitive={preventLeaks=false}` for secrets that legitimately leave the system. See [`@sensitive`](/reference/item-decorators/#sensitive).
- **`@internal` decorator** - Mark items used only by varlock (for example secret-zero tokens) so they resolve but are not injected into your app. See [`@internal`](/reference/item-decorators/#internal).

### macOS Keychain CLI

- **`varlock keychain` commands** - Import plaintext secrets from `.env` files into macOS Keychain, set items interactively, list entries, and fix access controls. See the [macOS Keychain plugin docs](/plugins/macos-keychain/).

### `varlock run`, audit, and agent workflows

- **Smarter stdout redaction** - Interactive TTY tools like `psql` and `claude` keep raw terminal behavior; piped/redirected output is still redacted. ([PR #770](https://github.com/dmno-dev/varlock/pull/770))
- **Container-friendly signal forwarding** - `varlock run` forwards SIGTERM/SIGINT/SIGHUP/SIGQUIT to child processes and propagates exit status faithfully — safe as a container ENTRYPOINT / PID 1.
- **Monorepo-aware scanning** - `varlock audit` and `varlock init` no longer descend into child packages, and skip pure execution-environment plumbing like `PATH` and `npm_*`. See [`varlock audit`](/reference/cli-commands/#audit).
- **Bundled agent skill** - Version-pinned varlock guidance ships inside the npm package for agent discovery. See the [AI tools guide](/guides/ai-tools/).
- **Typegen hygiene** - Plain `.env`-only keys no longer leak into generated types; `varlock typegen` reports ignored keys.

### Fixes and reliability

- **Nested override provenance** - `varlock run`-injected values are no longer treated as true overrides by inner loads. ([PR #756](https://github.com/dmno-dev/varlock/pull/756))
- **Circular `@import()` detection** - Clear errors instead of crashes when schemas import each other. ([PR #809](https://github.com/dmno-dev/varlock/pull/809))
- **Biometric session stability** - Fixed session fragmentation under turborepo and duplicate daemon races. ([PR #754](https://github.com/dmno-dev/varlock/pull/754))
- **Encryption via stdin** - Plaintext no longer passed on argv to the native encryption binary. ([PR #577](https://github.com/dmno-dev/varlock/pull/577))

## 🔌 Integrations and Plugins

### New plugin

- **[`@varlock/kubernetes-plugin`](/plugins/kubernetes/)** - Read Secrets and ConfigMaps from a cluster via kubeconfig, in-cluster service account, or explicit API credentials. Thanks [@idorozin](https://github.com/idorozin).

### Secret provider updates

June shipped coordinated **`2.0.0`** releases across password manager and secrets plugins — **breaking:** service-account and auth-token data types are now [`@internal`](/reference/item-decorators/#internal) by default so secret-zero credentials stay out of your application env. Override with `@internal=false` if your app uses the credential directly.

Affected packages include **[`@varlock/1password-plugin`](/plugins/1password/)**, **[`@varlock/bitwarden-plugin`](/plugins/bitwarden/)**, **[`@varlock/dashlane-plugin`](/plugins/dashlane/)**, **[`@varlock/doppler-plugin`](/plugins/doppler/)**, **[`@varlock/hashicorp-vault-plugin`](/plugins/hashicorp-vault/)**, **[`@varlock/infisical-plugin`](/plugins/infisical/)**, **[`@varlock/keepass-plugin`](/plugins/keepass/)**, **[`@varlock/keeper-plugin`](/plugins/keeper/)**, **[`@varlock/passbolt-plugin`](/plugins/passbolt/)**, **[`@varlock/proton-pass-plugin`](/plugins/proton-pass/)**, **[`@varlock/akeyless-plugin`](/plugins/akeyless/)**, and **[`@varlock/kubernetes-plugin`](/plugins/kubernetes/)**.

Cloud secret manager plugins also gained opt-in **`cacheTtl`** disk caching in their `1.2.x` releases — including **[`@varlock/aws-secrets-plugin`](/plugins/aws-secrets/)**, **[`@varlock/azure-key-vault-plugin`](/plugins/azure-key-vault/)**, **[`@varlock/google-secret-manager-plugin`](/plugins/google-secret-manager/)**, **[`@varlock/hashicorp-vault-plugin`](/plugins/hashicorp-vault/)**, **[`@varlock/infisical-plugin`](/plugins/infisical/)**, **[`@varlock/akeyless-plugin`](/plugins/akeyless/)**, and others — see each plugin's docs and the [caching guide](/guides/caching/).

Other plugin highlights:

- **[`@varlock/proton-pass-plugin`](/plugins/proton-pass/)** - Personal access token login (`PROTON_PASS_PERSONAL_ACCESS_TOKEN`) for non-interactive CI and headless workflows.
- **[`@varlock/infisical-plugin`](/plugins/infisical/)** - Fixed OIDC auth for `@infisical/sdk` v5.

### Integrations

- **[`@varlock/cloudflare-integration`](/integrations/cloudflare/)** - Astro Cloudflare adapter support (including Astro v7), SvelteKit auto-detection in `varlockVitePlugin()`, and wrangler `.env` auto-loading disabled so varlock remains the source of truth.
- **[`@varlock/astro-integration`](/integrations/astro/)**, **[`@varlock/vite-integration`](/integrations/vite/)**, **[`@varlock/nextjs-integration`](/integrations/nextjs/)**, and **[`@varlock/expo-integration`](/integrations/expo/)** - Compatibility and env-reload updates alongside core releases.
- **[`env-spec-language`](/env-spec/vs-code-ext/)** and **[`@env-spec/parser`](https://github.com/dmno-dev/varlock/releases/tag/%40env-spec/parser%400.4.1)** - Parser and editor tooling updates for object/array literals and multi-line decorator syntax.

## 🐣 Varlock SideQuest: fledgling

_**SideQuest** is our label for sibling projects that extend the Varlock universe without living inside the core repo._

[fledgling](https://github.com/dmno-dev/fledgling) is the latest: a CLI to **create npm packages and configure OIDC trusted publishing** in one shot — claim package names, wire GitHub/GitLab/CircleCI as trusted publishers, and keep monorepo settings in sync. Run `npx fledgling` to get started. We already use it in the Varlock monorepo via `fledgling sync`.

## 🌐 Content Highlights

- **New [mise integration guide](/integrations/mise/)** - Install varlock with mise and wire validated env into tasks without loading secrets into your shell session.
- **[Recommended approach for claude code "agents view"?](https://github.com/dmno-dev/varlock/discussions/751)** - Community discussion on using varlock with Claude Code's agent-oriented workflows.
- **[fledgling launch post](https://bsky.app/profile/theozero.bsky.social/post/3mol6lbf3j22g)** - Announcing trusted publishing setup for npm packages.

## 💬 Community

We're always looking for feedback and ideas. Join our community:

- [Discord](https://chat.dmno.dev) - Chat with us and other users.
- [GitHub Discussions](https://github.com/dmno-dev/varlock/discussions) - Suggestions, questions, and feature ideas.
- [GitHub](https://github.com/dmno-dev/varlock) - Star the project and follow updates.
- [X](https://x.com/varlockdev) - Follow us on X.
- [Bluesky](https://bsky.app/profile/varlock.dev) - Follow us on Bluesky.
