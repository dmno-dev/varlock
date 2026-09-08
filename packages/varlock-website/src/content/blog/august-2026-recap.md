---
title: "August 2026 Recap"
description: "Varlock ships a new Nuxt integration, native encryption helper binaries as per-platform optional deps, varlock printenv --template, and a repo-wide move to tsdown."
date: 2026-09-01
image: ../../assets/blog/august-2026-recap.jpeg
authors:
  - name: "Varlock Team"
---

August was a consolidation month after July's big release. The headline items: a new Nuxt integration, native local-encryption helper binaries shipping as per-platform optional dependencies, a `varlock printenv --template` flag, and every package moving to tsdown with corrected `package.json` entry points. Along the way we landed a batch of redaction and CLI fixes. Core shipped [varlock](/reference/cli-commands/) 1.16.1, 1.17.0, and 1.17.1.

## 🔧 Core Improvements

### Install and packaging

- **Native helpers as per-platform optional deps** - Local-encryption helper binaries now ship as `@varlock/native-helper-darwin`, `-linux-x64`, `-linux-arm64`, and `-win32-x64` optional dependencies, so `npm install` only downloads the binary for your own platform. Linux installs also pull the Windows helper, since WSL needs it. See the [local encryption guide](/guides/local-encryption/#platform-details--setup).
- **Linux binaries now uncompressed** - UPX packing on the Linux helper binaries was causing antivirus false positives (Windows Defender flagging them as `Wacatac.C!ml`). They now ship uncompressed. See [antivirus false positives](/guides/local-encryption/#antivirus-false-positives).
- **tsdown everywhere** - All packages now build with tsdown instead of tsup, publish explicit `.mjs`/`.cjs` files, and have corrected `package.json` entry points: references to files that were never built are gone, and import/require conditions are declared explicitly. This is the reason almost every package in the repo, from integrations to plugins to the parser, picked up a patch release on August 25.

### CLI

- **`varlock printenv --template`** - Renders a string template with resolved values, with multiple `{{KEY}}` placeholders and an optional `--escape json` for embedding values inside a JSON string, useful for building an auth header blob for something like an MCP `headersHelper`. See [`varlock printenv`](/reference/cli/load-and-run/#printenv).
- **`varlock flatten` improvements** - No longer needs to detect a workspace root: any `@import` path that resolves on disk is flattened, including in non-JS monorepos. Windows-style `@import`/`@plugin` paths now get a clearer error telling you to use forward slashes or a relative/`~` path instead. See [`varlock flatten`](/reference/cli/project/#flatten).
- **Injected env blob reuse tracks source edits** - `varlock/auto-load` and `varlock run` now detect when a `.env` source file has changed since an injected `__VARLOCK_ENV` blob was created, and re-resolve instead of serving stale values. See [reusing an injected env blob](/integrations/javascript/#reusing-an-injected-env-blob).
- **Startup and ergonomics** - CLI command implementations are now lazy-loaded so startup doesn't parse every command, the CLI exits cleanly instead of crashing when its output is piped into a consumer that closes early (e.g. `varlock flatten | head -3`), and unknown flags, unknown commands, and bad option values all get clearer errors.
- **Telemetry** - Now honors `DO_NOT_TRACK` alongside the existing `VARLOCK_TELEMETRY_DISABLED`. Thanks [@jdalton](https://github.com/jdalton). Proxy subcommand usage is also tracked, and events are no longer dropped when a command exits before the telemetry request finishes. See the [telemetry guide](/guides/telemetry/).

### Security and redaction

- **`@preventLeak` fix for srvx-based servers** - Response leak scanning was breaking TanStack Start and Nitro. The global `Response` is now patched with a proxy instead of a subclass, which fixes it. See the [TanStack Start integration](/integrations/tanstack-start/).
- **Better console redaction** - Runtime redaction now covers `Error` objects passed to console methods (messages, stack traces, and anything nested inside), and plain objects that couldn't previously survive a JSON round-trip: nested errors, circular references, bigints, and dates. See [runtime log redaction](/guides/secrets/#runtime-log-redaction).

## 🔌 Integrations and Plugins

### Integrations

- **New: [`@varlock/nuxt-integration`](/integrations/nuxt/)** - 0.1.0 supports Nuxt 3 and 4: build-time inlining and validation via the shared Vite plugin, log redaction and response leak prevention in the Nitro server, dev server restarts on env file changes (including config-time values), automatic registration of generated env types, and an auto-injected endpoint serving public dynamic values to the browser. See the [public dynamic env endpoint](/integrations/nuxt/#public-dynamic-env-endpoint) and [dev server behavior](/integrations/nuxt/#dev-server-behavior).
- **[`@varlock/vite-integration`](/integrations/vite/)** - New `rootDir` option for frameworks that set Vite's root to a source subdirectory, an exported `buildVarlockSsrInitCode` for build pipelines Vite doesn't own, and a fix for `{{ ENV.X }}` in Vue template interpolation, which was falling through to the runtime proxy and breaking hydration in production builds.
- **[`@varlock/cloudflare-integration`](/integrations/cloudflare/)** - `varlock-wrangler dev` no longer restarts wrangler on cosmetic env-file edits (whitespace, comments) that leave every resolved value unchanged.
- **[`@varlock/nextjs-integration`](/integrations/nextjs/)** - The env reload log now correctly reports "no changes found" instead of always saying changes were found.
- **[`@varlock/astro-integration`](/integrations/astro/)** and **[`@varlock/expo-integration`](/integrations/expo/)** - Packaging updates alongside core.

### Plugins

- **[`@varlock/dashlane-plugin`](/plugins/dashlane/)** - `dashlane()` no longer hangs forever on a locked vault: `dcli` calls now run with stdin closed and a timeout (default 30s, configurable via `@initDashlane(timeoutMs=...)`). New `allowMissing` option, settable per item or in `@initDashlane`, resolves missing vault entries as empty instead of failing.
- **[`@varlock/keepass-plugin`](/plugins/keepass/)** - Fixed opening KeePass databases, which failed with `errorHandler object is no longer supported`. Database setup is now deferred until a `kp()`/`kpBulk()` call actually runs, so an unused instance with an empty master password no longer fails the whole schema.
- **Packaging patch across the rest of the plugins** - 1Password, Akeyless, AWS Secrets, Azure Key Vault, Bitwarden, Doppler, Google Secret Manager, HashiCorp Vault, Infisical, Keeper, Kubernetes, pass, Passbolt, and Proton Pass all picked up the tsdown and entry-point patch above. See the [plugins overview](/plugins/overview/).
- **[`env-spec-language`](/env-spec/vs-code-ext/) 0.3.3**, **[`@env-spec/parser` 0.5.1](https://github.com/dmno-dev/varlock/releases/tag/%40env-spec/parser%400.5.1)**, and **[`@varlock/ci-env-info` 0.1.1](https://github.com/dmno-dev/varlock/releases/tag/%40varlock/ci-env-info%400.1.1)** - Packaging-only releases.

## 🌐 Content Highlights

- **New [Modal](/sandboxes/modal/) sandbox guide** - Resolving and validating sandbox env vars, and running the credential proxy so an agent in a Modal sandbox only ever holds placeholders.
- **varlock.dev is more agent-readable** - Richer `llms.txt`, an MCP server card at `/.well-known/mcp.json`, an `ai-catalog.json`, and a markdown 404 body for agents that hit a dead link. See [machine-readable discovery](/guides/ai-tools/#machine-readable-discovery).
- **[Discussion #1041](https://github.com/dmno-dev/varlock/discussions/1041)** - A user asked how to use a varlock value inside a `package.json` script. Answer: `$(varlock printenv VAR)`, or `varlock run -- sh -c '...'` so shell expansion happens inside the varlock-managed child process instead of before varlock runs.

## 💬 Community

We're always looking for feedback and ideas. Join our community:

- [Discord](https://chat.dmno.dev) - Chat with us and other users.
- [GitHub Discussions](https://github.com/dmno-dev/varlock/discussions) - Suggestions, questions, and feature ideas.
- [GitHub](https://github.com/dmno-dev/varlock) - Star the project and follow updates.
- [X](https://x.com/varlockdev) - Follow us on X.
- [Bluesky](https://bsky.app/profile/varlock.dev) - Follow us on Bluesky.
