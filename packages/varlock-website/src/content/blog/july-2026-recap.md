---
title: "July 2026 Recap"
description: "Varlock ships a credential proxy for AI agents, code generation for seven more languages, array and record value types, and varlock flatten for Docker builds."
date: 2026-08-01
image: ../../assets/blog/july-2026-recap.jpeg
authors:
  - name: "Varlock Team"
---

July was our biggest month yet: [`varlock@1.10.0`](/reference/cli-commands/) through [`varlock@1.16.0`](/reference/cli-commands/) shipped a credential proxy that hands AI agents placeholder secrets instead of real ones, code generation for Python, Rust, Go, PHP, Java, and C#, array and record value types, and a new `varlock flatten` command for monorepo Docker builds. A new [Sandboxes](/sandboxes/overview/) docs section covers running agents in ten different sandboxing tools with varlock holding the credentials.

## 🔧 Core Improvements

### Credential proxy for AI agents (preview)

The headline feature: run an agent (or any untrusted tool) through a local MITM proxy so it only ever sees placeholder secrets. Real values are injected at the wire, bound to a verified upstream TLS identity, responses are scrubbed back to placeholders, and every request is policy-checked and audited. Mark a secret with `@proxy(domain="api.example.com")` and route with host/path/method rules. See the [proxy guide](/guides/proxy/) and [`varlock proxy`](/reference/cli/proxy/#proxy) reference.

- **Routing rules and egress control** - `block` and `approval` rules, per-domain grouping, and `@proxyConfig={egress="strict"}` to control what the child can reach at all. See [proxy routing rules](/guides/proxy/rules/#routing-rules) and [egress modes](/guides/proxy/rules/#egress-modes).
- **Named substitution targets** - Secrets are substituted into request headers only by default (excluding forward and log headers like `cookie` and `x-forwarded-*`), and a placeholder may appear at most once per request. Widen with `@proxy(substituteIn=[...])` using targets like `header:authorization`, `path`, `query:api_key`, or `body:client_secret`, and raise the cap with `maxOccurrences`. See [substitution surface](/guides/proxy/rules/#substitution-surface).
- **Sandboxing** - `proxy run --sandbox` runs the agent in a sandbox whose only egress is the proxy: a built-in macOS credential and egress jail, or `--sandbox=docker` (or `=podman`) to run it in a container while your secrets stay on the host. See the [sandboxing guide](/guides/proxy/sandboxing/#built-in-sandbox).
- **Remote sandboxes** - `proxy start` and `run` gain `--expose` plus a built-in CONNECT-over-WebSocket tunnel, so a client behind provider HTTP ingress (E2B, Modal, and similar) can route through it. `varlock proxy run --url <wss-url> -- <command>` runs a command through a broker running elsewhere, self-wiring env and CA certs while holding only placeholders. `varlock proxy token` prints a session's data-plane token, and `--persist-ca` keeps a broker's CA across restarts. See [remote proxy setup](/guides/proxy/running/#remote-proxy-start---expose--proxy-run---url).
- **Live policy reload** - `varlock proxy reload` no longer requires the schema to resolve in the requesting shell. The proxy validates the edit in its own context before applying and reports failures back, so a remote broker can be reloaded with a bare provider exec. See [editing the schema while a session is running](/guides/proxy/running/#editing-the-schema-while-a-session-is-running).
- **Client compatibility** - Minted MITM certs now include subject and authority key identifiers so strict TLS verifiers (Python 3.13+ urllib and httpx defaults) accept them; the injected env sets `NODE_USE_ENV_PROXY=1` so Node's built-in fetch routes through the proxy instead of silently bypassing it, and `DENO_CERT` so Deno trusts the proxy CA. Also fixed a roughly 1-in-512 cert failure from non-minimal DER serial numbers. See [client compatibility](/guides/proxy/running/#client-compatibility).
- **Proxying through a proxy** - `proxy run --url` now dials its tunnel through an HTTP proxy (`HTTP(S)_PROXY` / `NO_PROXY`), so a sandboxed agent whose only egress is a gateway (for example [Docker Sandboxes](/sandboxes/docker-sandboxes/)) can still reach a broker.

Preview caveat: on its own the proxy is same-uid and raises the bar rather than being a boundary. `--sandbox` (or a container) is what makes it one. See [limitations](/guides/proxy/#limitations).

### Code generation for seven languages

- **Per-language decorators** - [`@generatePythonEnv()`](/reference/root-decorators/#generatepythonenv), [`@generateRustEnv()`](/reference/root-decorators/#generaterustenv), [`@generateGoEnv()`](/reference/root-decorators/#generategoenv), [`@generatePhpEnv()`](/reference/root-decorators/#generatephpenv), [`@generateJavaEnv()`](/reference/root-decorators/#generatejavaenv), and [`@generateCsharpEnv()`](/reference/root-decorators/#generatecsharpenv). Each emits a self-contained, idiomatic module with typed coerced values, a loader that parses the injected env, and a `SENSITIVE_KEYS` constant. See the [code generation guide](/guides/code-generation/) and the new [Python](/integrations/python/), [Rust](/integrations/rust/), [Go](/integrations/go/), [PHP](/integrations/php/), [Java](/integrations/java/), and [C#](/integrations/csharp/) integration docs.
- **TypeScript generator moved** - `@generateTypes(lang=ts)` is now [`@generateTsTypes()`](/reference/root-decorators/#generatetstypes), with options to control `process.env` / `import.meta.env` augmentation and a monorepo-friendly `exposeEnv=local` mode. The old form still works as a deprecated alias.
- **`varlock typegen` is now `varlock codegen`** - `typegen` is kept as a deprecated alias. See [`varlock codegen`](/reference/cli/cache-and-codegen/#codegen).
- **Plugins can extend codegen** - Plugin-registered data types can declare `coercedType` so generated env modules type their fields correctly instead of emitting everything as strings. See [extending with plugins](/guides/code-generation/#extending-with-plugins).

### Schema and CLI

- **Array and record types** - [`@type=array(...)`](/reference/data-types/#array) and [`@type=record(...)`](/reference/data-types/#record) with per-element validation, native `[a, b]` and `{k=v}` literal values, JSON and separator string input, configurable serialization back to `process.env`, and per-element redaction.
- **`--filter` and `@tag()`** - Select env vars by key or glob, by `@sensitive` / `@required` / `@dynamic`, or by tag with the new [`@tag()`](/reference/item-decorators/#tag) decorator. `@generate*` decorators take a matching `filter=` arg, so one schema can emit multiple generated files scoped to different subsets. Decorator-based filters also scope resolution and validation, so a build-time `--filter='!@dynamic'` skips runtime-only vars entirely, including their `@required` checks. See [filtering items](/reference/cli-commands/#filtering-items).
- **Static and dynamic config controls** - [`@dynamic`](/reference/item-decorators/#dynamic) and [`@static`](/reference/item-decorators/#static) item decorators, [`@defaultDynamic`](/reference/root-decorators/#defaultdynamic), and dynamic-plus-public framework and runtime support. See the new [static vs dynamic vars guide](/guides/dynamic-config/).
- **`varlock flatten`** - Collapses the `@import` graph into a self-contained directory, rewriting import paths and pinning plugin versions, so a single package can be deployed without the rest of the monorepo. `--vendor-plugins` copies plugins into the output for a fully self-contained artifact that resolves with no runtime npm fetch, no shell, and no trust prompt. See [`varlock flatten`](/reference/cli/project/#flatten) and the [Docker guide](/integrations/docker/#monorepos-and-partial-build-context).
- **`generateOtp()`** - Generate TOTP 2FA codes from a stored seed. See [`generateOtp()`](/reference/functions/#generateotp).
- **Load failure reporting** - `varlock/auto-load` can now throw the load error instead of exiting silently, so a reporter like Sentry can capture it. Opt in with a `globalThis._varlockOnLoadError` hook or `_VARLOCK_THROW_ON_LOAD_ERROR=1`. See [reporting load failures](/integrations/javascript/#reporting-load-failures).
- **Injected env blob reuse** - `varlock/auto-load` and `varlock run` reuse an injected `__VARLOCK_ENV` blob instead of re-resolving when it was resolved in the same directory. Pin the behavior with [`_VARLOCK_USE_INJECTED_ENV`](/reference/reserved-variables/#_varlock_use_injected_env), which is useful when handing env into a sandbox with no `.env` files. See [reusing an injected env blob](/integrations/javascript/#reusing-an-injected-env-blob).
- **Better CLI errors** - Unknown or misspelled flags are rejected with a did-you-mean suggestion instead of being silently ignored.

### Platform, runtime, and OS detection

- **[`@varlock/ci-env-info`](https://github.com/dmno-dev/varlock/releases/tag/%40varlock/ci-env-info%400.1.0)** - Now published as its own package. Adds detection for Railway, AWS Amplify, Google Cloud Run, Deno Deploy, Zeabur, and Firebase App Hosting, and detects dev sandboxes (CodeSandbox, StackBlitz, GitHub Codespaces, Gitpod, Replit) with `isCI: false`.
- **`VARLOCK_RUNTIME` and `VARLOCK_OS`** - New builtin variables backed by `detectRuntime` and `detectOs`. See [builtin variables](/reference/builtin-variables/).
- **Detection fixes** - An audit against `std-env` fixed several wrong env var names (GitHub Actions PR number, GitLab MR IID, Netlify build URL, Semaphore and Azure Pipelines PR numbers, Bitbucket repo owner) and made `vercel dev` / `netlify dev` report `isCI: false`.

### Security and reliability

- **Compressed response leak scanning** - Gzipped responses that fit in a single chunk were never scanned, so browsers could receive leaked sensitive values the scanner should have blocked. Brotli and zstd are now scanned too, and compressed chunks containing a leak fail closed. Note that an app with an existing undetected leak will start seeing those responses blocked after upgrading: look for `DETECTED LEAKED SENSITIVE CONFIG` in server logs.
- **`@internal` items excluded from `load --format json-full`** - Framework integrations shell out to this exact command for their injected config, so this closes a leak where an [`@internal`](/reference/item-decorators/#internal) secret-zero credential could reach client or SSR runtime code. Pass `--include-internal` to opt in for local debugging.
- **Signed and verified release artifacts** - The install script verifies the sha256 of the downloaded archive against the release's published `checksums.txt` and fails without installing on a mismatch.
- **Windows TPM and WSL** - Windows local encryption now uses TPM-sealed keys via NCrypt when available, with existing DPAPI keys auto-upgrading on the next decrypt. `install.sh` also installs `varlock-local-encrypt.exe` on WSL so local encryption can use the Windows TPM/Hello backend (`--skip-win-exe` to opt out). Thanks [@cturner8](https://github.com/cturner8).
- **Encrypted blob injection from the CLI** - [`@encryptInjectedEnv`](/reference/root-decorators/#encryptinjectedenv) is now honored when `varlock run` and `varlock proxy run` inject the env blob, not just on the library auto-load and build-time paths.
- **Cache lock recovery** - Locks left behind by an interrupted run are reclaimed immediately instead of stalling later runs for minutes and hiding the real error. `varlock cache clear` also clears locks.
- **Fixes** - `varlock audit` now honors [`@auditIgnore`](/reference/item-decorators/#auditignore); nested `varlock run` command-local overrides win over the parent's injected value again; `pick` and `omit` filters apply to [directory imports](/guides/import/#directory); root decorators resolve the full dependency chain of items referenced in their args; refs in `@cache` values no longer resolve as undefined; `forEnv()` errors on arguments that resolve to undefined; numeric `Infinity` is rejected in number coercion; and `varlock run` no longer OOMs on a bare PATH binary like `node`.

**Breaking changes worth noting:** `ENV` is no longer exported from the package root (import it from `varlock/env`), the minimum supported Node version is now 22.3, and [`@disableProcessEnvInjection`](/reference/root-decorators/#disableprocessenvinjection) requires a static `true` / `false` value since generated code must not differ per environment.

## 🔌 Integrations and Plugins

### Integrations

- **[`@varlock/nextjs-integration`](/integrations/nextjs/)** - Fixed dev-server env reloading on turbopack and Next 16, added pages router and middleware support (webpack builds, edge bundle analysis, encrypted deployments in middleware and edge routes), and made turbopack static `ENV.x` replacement AST-based so string literals and comments are no longer corrupted. Also preserves all `"use ..."` directives including stacked ones. Thanks [@mhornbacher](https://github.com/mhornbacher).
- **[`@varlock/vite-integration`](/integrations/vite/)** - Fixed Astro plus Cloudflare static and prerendered builds (`REQUIRE_TLA` errors), and now warns when deploying to Vercel with resolved env injection and no encryption enabled.
- **[`@varlock/cloudflare-integration`](/integrations/cloudflare/)** - Fixed `.dev.vars` quoting so secrets with apostrophes, quotes, and backslashes round-trip correctly through Wrangler, and stopped embedding `.dev.vars` contents in the preview helper's process argv.
- **[`@varlock/astro-integration`](/integrations/astro/)** and **[`@varlock/expo-integration`](/integrations/expo/)** - Compatibility updates alongside core releases.
- **FIFO env sources** - Non-regular env sources such as 1Password Environments are now detected and skipped for dev-server restart watching across the Next.js, Vite, and Cloudflare integrations, fixing dev-server hangs and endless no-op reload logs.

### Plugins

- **[`@varlock/hashicorp-vault-plugin`](/plugins/hashicorp-vault/)** - New `vaultToken()` resolver exposes the authenticated Vault client token.
- **[`@varlock/infisical-plugin`](/plugins/infisical/)** - `allowMissing` flag on `infisical()` and `@initInfisical()` for optional secrets.
- **[`@varlock/1password-plugin`](/plugins/1password/)** - Fixed CLI batch reads failing with "expected data on stdin but none found" on Windows, and one-time password codes are never cached.
- **[`env-spec-language`](/env-spec/vs-code-ext/)** and **[`@env-spec/parser`](https://github.com/dmno-dev/varlock/releases/tag/%40env-spec/parser%400.5.0)** - Array and record types, autocomplete and hover docs for `@tag()`, `filter=`, `@internal`, and `generateOtp()`, plus a fix for `$(...)` truncation on nested parentheses.

## 🌐 Content Highlights

- **New [Sandboxes](/sandboxes/overview/) docs section** - Recipes for running agents in E2B, Fly.io, Docker Sandboxes, smolvm, Fence, yolobox, Agent Safehouse, bubblewrap, MXC, and minimal setups, with varlock holding the real credentials. Start with [topologies](/sandboxes/overview/#topologies) to pick a shape.
- **[Software Defined Talk #580](https://www.softwaredefinedtalk.com/580)** - The founders sat down with the show to talk about why almost nobody manages their `.env` files well. Thanks [@brandonwhichard.com](https://bsky.app/profile/brandonwhichard.com) for the [conversation](https://bsky.app/profile/varlock.dev/post/3mqcfhdfftc2h).
- **[Credential brokering announcement](https://bsky.app/profile/theozero.bsky.social/post/3mr6sqf4qgk2m)** - The proxy launch post: your agent gets placeholder credentials, real secrets are swapped in over the wire, and the rules live in your existing `.env.schema`.
- **[varlock@1.10 codegen post](https://bsky.app/profile/theozero.bsky.social/post/3mq36tsbwz22j)** - Arbitrary code generation plus built-in support for PHP, Python, Go, and Rust.
- **New guides** - [Code generation](/guides/code-generation/), [static vs dynamic vars](/guides/dynamic-config/), and a reorganized [CLI reference](/reference/cli-commands/) split by command group.

## 💬 Community

We're always looking for feedback and ideas. Join our community:

- [Discord](https://chat.dmno.dev) - Chat with us and other users.
- [GitHub Discussions](https://github.com/dmno-dev/varlock/discussions) - Suggestions, questions, and feature ideas.
- [GitHub](https://github.com/dmno-dev/varlock) - Star the project and follow updates.
- [X](https://x.com/varlockdev) - Follow us on X.
- [Bluesky](https://bsky.app/profile/varlock.dev) - Follow us on Bluesky.
