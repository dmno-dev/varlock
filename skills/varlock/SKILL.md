---
name: varlock
description: >-
  Secure environment variable management with Varlock.
  Use when handling secrets, API keys, credentials, or any sensitive configuration.
  Ensures secrets are never exposed in terminal, logs, or LLM context.

  Provides guidance around integrating varlock into a project, reading/editing .env.schema and other .env files, using the varlock CLI, adding plugins and framework integrations.

  Trigger phrases include "environment variable", "env var", "secrets", ".env", "API key", "credentials", "sensitive", "varlock"
---

# Varlock

This skill helps securely manage env vars and secrets in your project using varlock.

> **Docs**: https://varlock.dev
> **Repo**: https://github.com/dmno-dev/varlock

Varlock uses `.env.schema` (instead of `.env.example`) to provide a single source of truth for your project's env vars. Schema info is expressed using `@decorator` style comments. Sensitive values can be set in git-ignored `.env.local` files, passed in via the environment, or use functions to load from secure backends like 1Password, Vault, AWS, etc.

Basic `.env.schema` example:
```env-spec
# @defaultSensitive=false @defaultRequired=infer
# @currentEnv=$APP_ENV
# @generateTypes(lang=ts, path=env.d.ts)
# ---

# @type=enum(dev, staging, prod)
APP_ENV=dev

# @type=url
API_URL=https://api.example.com

# Description of this var
# @sensitive @required @type=string(startsWith=sk-)
# @docs(https://xyzapi.com/docs/auth)
XYZ_API_KEY=
```

Your `.env.schema` is committed to version control and safe for agents to read and update. The `varlock` CLI helps load and validate env vars while masking anything sensitive, and can securely inject env vars into commands.

**NOTE:** If varlock is installed locally via `package.json` (not as a standalone binary), invoke it via your package manager — e.g., `pnpm exec varlock load`, `bunx varlock load`, `npm exec varlock load`. Check the project's package manager before running CLI commands.

## CRITICAL: Security rules

These rules are non-negotiable:

### Do not expose secrets

```bash
# NEVER do these - exposes secrets to agent context
cat .env
cat .env.local
echo $SECRET_KEY
printenv | grep API

# SAFE alternatives
varlock load --agent    # JSON output, sensitive values redacted
varlock load            # human-readable, sensitive values masked
cat .env.schema         # schema only, no secret values
```

If the user needs to see a sensitive value, tell them to run `varlock reveal VAR_NAME`.

### File access rules

- **Safe to read and edit:** `.env.schema` and any other git-committed `.env` files (usually env-specific files like `.env.development`)
- **Do not read or edit:** `.env`, `.env.local`, `.env.[env].local`, or other gitignored value/override files — these may contain unencrypted secrets
- **Do not log or quote** raw secret values in code, comments, or chat

### Sensitivity rules

- Items marked `@sensitive` must not have that decorator removed without confirming with the user
- Ask the user to edit secret values in their local/gitignored env files or their secret provider (1Password, AWS, etc.) — never fill in secrets yourself

### When the user asks to "show me the .env file"

Do not read `.env` or `.env.local` directly. Instead run `varlock load` to show masked values, or read `.env.schema` to show the schema. Explain that reading env files directly could expose secrets.

### When the user asks to "update/set a secret"

Do not write secret values yourself. Tell the user to either:
1. Update it in their secret provider (1Password, AWS, etc.) and then help them wire it up
2. Edit the value in their `.env.local` file manually
  - ideally encrypt it by using `varlock(prompt)` as the value, then run `varlock load` to be prompted

Then run `varlock load --agent` to validate.

## File roles

| File | Role | Agent may edit? |
|------|------|-----------------|
| `.env.schema` | Schema, defaults, decorators, descriptions | Yes |
| `.env.[env]` | Environment-specific tracked config (e.g. `.env.production`) | Yes |
| `.env`, `.env.local` | Local/gitignored values and overrides | No — tell user to edit |
| `.env.[env].local` | Environment-specific local overrides (gitignored) | No — tell user to edit |
| `.env.example` | Legacy example file; migrate into schema | Review with user |

Ensure `.env.schema` and tracked env-specific files are not gitignored (`!.env.schema`, `!.env.production`, etc. in `.gitignore` if needed).

### Environment-specific files and precedence

When `@currentEnv` is set in `.env.schema` (e.g., `@currentEnv=$APP_ENV`), varlock automatically loads matching environment-specific files. Files are applied in increasing precedence order:

`.env.schema` < `.env` < `.env.local` < `.env.[currentEnv]` < `.env.[currentEnv].local` < `process.env`

For example, if `APP_ENV=staging`, then `.env.staging` and `.env.staging.local` will be loaded automatically if they exist. A value in `.env.local` overrides one in `.env.schema`, and `process.env` always wins.

## Schema syntax

### Root decorators (file header)

Root decorators go in comment blocks at the top of the file, before the first item. A `# ---` divider usually separates the header from items.

| Decorator | Purpose | Default |
|-----------|---------|---------|
| `@currentEnv=$VAR` | Sets which item determines the active environment | — |
| `@defaultRequired=bool\|infer` | Default required state for items in this file | `infer` |
| `@defaultSensitive=bool\|inferFromPrefix(PREFIX)` | Default sensitive state for items in this file | `true` |
| `@generateTypes(lang=ts, path=./env.d.ts)` | Auto-generate typed env declarations | — |
| `@import(path, ...keys?)` | Import schema/values from another .env file or directory | — |
| `@plugin(@varlock/name-plugin)` | Load a plugin | — |
| `@setValuesBulk(resolver)` | Inject multiple values from an external source | — |
| `@disable` | Disable loading this file (can use `=forEnv(test)`) | `false` |

- `@defaultSensitive` defaults to `true` — all items are sensitive unless explicitly marked `@public` or `@sensitive=false`. Set `@defaultSensitive=false` to flip the default.
- `@defaultRequired=infer` (the default): items with a value in the schema are required, items without are optional
- `@defaultSensitive=inferFromPrefix(PUBLIC_)`: items with keys starting with `PUBLIC_` are not sensitive, all others are
- `@import()` accepts `enabled=expr` for conditional imports and `allowMissing=true` for optional imports

### Item decorators

Decorators in comment lines directly preceding a config item are attached to that item. A blank line breaks the association.

| Decorator | Purpose |
|-----------|---------|
| `@required` / `@optional` | Override default required state |
| `@sensitive` / `@public` | Override default sensitive state |
| `@type=dataType` | Set validation/coercion type |
| `@example="value"` | Example value (for docs, not used at runtime) |
| `@docs(url)` or `@docs(label, url)` | Link to related documentation (can be used multiple times) |
| `@icon=collection:name` | Iconify icon ID for generated docs |
| `@auditIgnore` | Suppress "unused in code" warning from `varlock audit` |

Decorator values can use resolver functions: `@required=forEnv(prod)`, `@sensitive=not(forEnv(dev))`.

### Common data types (`@type=`)

`string(startsWith=X)`, `string(matches=/regex/)`, `number`, `boolean`, `url`, `email`, `port`, `enum(a, b, c)`, `ipAddress`, `semver`

Plain `string` is the default — do not add `@type=string`, just omit `@type` entirely. Only use `@type` when you need a specific type or string constraints. See https://varlock.dev/reference/data-types/

### Resolver functions (values)

Instead of static values, items can use resolver functions:

```env-spec
# Reference another item ($VAR and ${VAR} are shorthand for ref(VAR))
FULL_URL=${API_URL}/v2/users

# Execute a CLI command
SECRET=exec(`op read "op://vault/item/field"`)

# Conditional logic
API_URL=if(eq($APP_ENV, prod), https://api.example.com, http://localhost:3000)

# First non-empty value
FALLBACK_VAR=fallback($PRIMARY, $SECONDARY, "default")

# Map one value to another
APP_ENV=remap($CI_BRANCH, "main", production, /.*/, preview, undefined, development)

# Check environment (based on @currentEnv)
# @required=forEnv(prod, staging)
PROD_ONLY_KEY=
```

Key functions: `ref()`, `concat()`, `exec()`, `fallback()`, `if()`, `eq()`, `not()`, `isEmpty()`, `ifs()`, `remap()`, `forEnv()`

See https://varlock.dev/reference/functions/

## Setting sensitive values

There are two main approaches — they can be used together.

### Approach 1: Plugins (version-controlled secret references)

Varlock plugins let you declaratively reference secrets from external providers directly in your `.env.schema`. The references are safe to commit — actual values are fetched at load time.

```env-spec title=".env.schema"
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=forEnv(dev))
# ---
# @sensitive @type=opServiceAccountToken
OP_TOKEN=
# @sensitive
MY_SECRET=op(op://my-vault/item-name/field-name)
```

Each plugin provides its own resolver functions (e.g., `op()` for 1Password, `awsSecret()` for AWS). See [Plugins](#plugins) below for the full list and https://varlock.dev/guides/plugins/ for setup details.

### Approach 2: Local encryption with `varlock()` (git-ignored files)

For secrets stored locally in git-ignored files like `.env.local`, use the `varlock()` function for device-local encryption so nothing is stored in plaintext:

```env-spec title=".env.local"
# Encrypted value — decrypted automatically at load time
API_KEY=varlock("local:<encrypted-payload>")

# Prompt mode — on next `varlock load`, user is prompted to enter the value
# which is encrypted and written back to this file automatically
NEW_SECRET=varlock(prompt)
```

**How to encrypt values:**
- **Interactive prompt:** Set the value to `varlock(prompt)` and run `varlock load` — the user will be prompted securely, and the encrypted value replaces the placeholder automatically
- **Encrypt in bulk:** `varlock encrypt --file .env.local` encrypts all sensitive plaintext values in-place
- **Encrypt a single value:** `varlock encrypt` prompts for a value and prints the encrypted result to copy/paste
- **Pipe via stdin:** To encrypt a value without exposing it in your context (e.g., a generated key or a value read from another tool), pipe it into `varlock encrypt`:
  ```bash
  some-cli-that-outputs-secret | varlock encrypt
  # prints: SOME_SENSITIVE_KEY=varlock("local:<encrypted>")
  ```
  This keeps the plaintext secret out of shell history and agent context.

Encryption is hardware-backed on macOS (Secure Enclave + Touch ID), Windows (DPAPI + Windows Hello), and Linux (TPM2), with a file-based fallback on all platforms. On macOS, `keychain()` is also available as a built-in alternative that stores values in the system keychain.

See https://varlock.dev/guides/local-encryption/

## Organization

Ask the user how their repo is structured before designing the env layout.

**Single project:** one `.env.schema` at the repo root is usually enough.

**Monorepo / multi-app:** use `@import()` to share common config:

```env-spec title="apps/web/.env.schema"
# Import shared config from root
# @import(../../.env.schema)
# Import from a sibling service (specific keys only)
# @import(../api/.env.schema, SHARED_API_URL, SHARED_DB_HOST)
# ---
APP_PUBLIC_URL=http://localhost:3000
```

- **Root schema** — shared service URLs, org-wide defaults, common keys
- **Per-app schemas** — app-specific items, importing what they need from root/siblings
- Keep imports explicit; avoid circular imports

Discuss with the user: which values belong at the root vs per-package, which environments they use.

See https://varlock.dev/guides/import/

## Plugins

Plugins add resolver functions, data types, and decorators for external secret providers. Install with `@plugin()` in your `.env.schema`:

```env-spec
# @plugin(@varlock/1password-plugin)
```

In JS projects, also install the npm package. With the standalone binary, pin a version: `@plugin(@varlock/1password-plugin@1.2.3)`.

**Available plugins:** 1Password, AWS Secrets Manager, Azure Key Vault, Bitwarden, Dashlane, Doppler, Google Secret Manager, HashiCorp Vault, Infisical, Akeyless, KeePass, Keeper, Passbolt, Proton Pass, Pass, macOS Keychain (built-in).

See https://varlock.dev/plugins/overview/ for setup details for each plugin.

## Integrations (frameworks / runtimes)

Pick the official integration for the project's framework — do not guess. Check https://varlock.dev/integrations/overview/ for the specific guide (Next.js, Vite, Astro, SvelteKit, Bun, Cloudflare, Expo, etc.).

Typical steps:
1. Confirm `varlock` is installed (`varlock init --agent` or existing dependency)
2. Follow the integration guide for build/dev wiring, generated types, and any required config
3. Prefer the integration's recommended entry point (`varlock/auto-load`, Vite plugin, etc.) over ad-hoc `process.env` usage

When a framework integration is active, it handles loading and injecting env vars automatically — `varlock run` is **not needed** for the framework's own dev/build commands. Only use `varlock run -- <cmd>` for other scripts or tools that the integration doesn't cover (e.g., one-off migrations, CLI tools, non-JS commands).

**Migrating from dotenv:** replace `dotenv/config` or `dotenvx run` with the varlock equivalent — see https://varlock.dev/guides/migrate-from-dotenv/

**Non-JS apps/services:** use `varlock run` or pipe `varlock load --format shell` — see https://varlock.dev/integrations/other-languages/

## Setup

**Installing varlock:**
- **JS projects:** Install as a dev dependency — `npm install -D varlock` (or `bun add -D varlock`, `pnpm add -D varlock`)
- **Standalone binary (non-JS or global use):** See https://varlock.dev/getting-started/installation/

**Getting started:**
1. Run `varlock init --agent` to auto-generate an initial `.env.schema` from existing `.env` / `.env.example` files
2. Review the generated schema with the user — init heuristics are a draft, not final
3. Optionally install this skill:
   - **skills** (recommended): `npx skills add dmno-dev/varlock` — update with `npx skills update varlock`
   - **GitHub CLI** (v2.90+): `gh skill install dmno-dev/varlock varlock` — update with `gh skill update varlock`

## Schema checklist

After init or when editing `.env.schema`:

1. Review auto-generated items — heuristics are not final
2. Add description comments where names are not self-explanatory
3. Set `@type` only when not a plain string (omit `@type=string`)
4. Mark `@required` / `@optional` as needed (or adjust root `@defaultRequired`)
5. Confirm `@sensitive` on secrets, keys, tokens, and credentials with the user
6. Move useful values to `@example`; delete dummy placeholders
7. Add `@docs()` links where helpful
8. Remove redundant values from other `.env` files after defaults move into the schema

## Validation loop

After schema changes:

```bash
varlock load --agent
```

Fix schema and tracked env files based on validation errors. Do not patch gitignored `.local` value files to silence schema errors — ask the user to update secrets locally.

## CLI quick reference

Run `varlock --help` or `varlock <command> --help` for full flags and options.

| Command | Use when |
|---------|----------|
| `varlock init --agent` | Setting up varlock non-interactively |
| `varlock load --agent` | Validating config safely (JSON, sensitive values redacted) |
| `varlock load` | Showing human-readable validation to the user |
| `varlock run -- <cmd>` | Injecting resolved env into a process |
| `varlock printenv VAR_NAME` | Print a single resolved env var to stdout |
| `varlock reveal` | Securely view/copy a sensitive value |
| `varlock encrypt` | Encrypt values (single or `--file` for bulk) |
| `varlock scan` | Scan files for leaked secrets (`--staged` for pre-commit, `--install-hook` to set up) |
| `varlock audit` | Detect drift between schema and code usage |
| `varlock typegen` | Explicitly trigger type generation from schema (usually triggered automatically) |
| `varlock lock` | Lock biometric session (requires re-auth on next decrypt) |

## Updating an existing project

Keep `.env.schema` as the source of truth. Edit schema and tracked `.env.[env]` files only — not gitignored `.local` files.

1. **Schema changes** — add/remove/rename items in `.env.schema`, update code to match, then `varlock load --agent`
2. **Secrets** — leave sensitive values empty in schema; ask the user to set them locally or in their secret provider
3. **Plugins** — add `@plugin()` in the header and prefer plugin resolvers over raw `exec()` when available
4. **Types** — `@generateTypes` runs on load by default; use `auto=false` and `varlock typegen` if you need explicit control
5. **Before commit** — `varlock load --agent`, then `varlock scan --staged`; run `varlock audit` if you renamed keys or suspect drift

See [Schema](https://varlock.dev/guides/schema/), [Secrets](https://varlock.dev/guides/secrets/), and [Monorepos](https://varlock.dev/guides/monorepos/) for deeper patterns.

## Advanced

- Multiple environments: https://varlock.dev/guides/environments/
- Split large schemas with `@import`: https://varlock.dev/guides/import/
- Device-local encryption: https://varlock.dev/guides/local-encryption/
- `package.json` config (`varlock.loadPath`): https://varlock.dev/reference/cli-commands/
- Built-in variables (`$VARLOCK_ENV` for auto-detecting environment): https://varlock.dev/reference/builtin-variables/

## Docs

For details beyond this skill, use the Varlock Docs MCP tool if installed in your AI tool, or refer to https://varlock.dev/guides/schema as a starting point.
