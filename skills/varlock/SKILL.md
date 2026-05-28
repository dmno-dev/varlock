---
name: varlock
description: >-
  Work with Varlock env-spec schemas and CLI. Use when editing .env.schema,
  setting up varlock, migrating from dotenv, adding plugins or framework
  integrations, configuring env validation, marking secrets @sensitive,
  running varlock init/load/scan/run, or integrating varlock into a project.
---

# Varlock

Varlock separates **schema** (safe for agents) from **secrets** (human/runtime only). Your `.env.schema` gives agents full context on variable names, types, validation rules, and descriptions without exposing secret values.

## Security rules

These rules are non-negotiable:

- **Safe to read and edit:** `.env.schema`, explicitly imported schema fragments, and `.env.[currentEnv]` files (e.g. `.env.development`, `.env.production`) — tracked, environment-specific config with the same role as schema
- **Do not read or edit:** `.env`, `.env.local`, `.env.[currentEnv].local`, or other gitignored value/override files — these contain local secrets and overrides
- **Do not log or quote** raw secret values in code, comments, or chat
- **Validate with:** `varlock load --agent` (JSON output with sensitive values redacted)
- **Show humans with:** `varlock load` (drop `--agent` for human-readable output)
- **Ask the user** to edit secret values in their local/gitignored env files or their secret provider (1Password, AWS, etc.) — never fill in secrets yourself

Confirm with the user: which items are `@sensitive`, required vs optional, and cleanup of placeholder items (remove `EXAMPLE_ITEM`, migrate defaults out of legacy files).

## File roles

| File | Role | Agent may edit? |
|------|------|-----------------|
| `.env.schema` | Schema, defaults, decorators, descriptions | Yes |
| `.env.[currentEnv]` | Environment-specific tracked config (e.g. `.env.production`) | Yes |
| `.env`, `.env.local` | Local/gitignored values and overrides | No — ask user |
| `.env.[currentEnv].local` | Environment-specific local overrides (gitignored) | No — ask user |
| `.env.example` | Legacy example file; migrate into schema | Review with user |

Ensure `.env.schema` and tracked env-specific files are not gitignored (`!.env.schema`, `!.env.production`, etc. in `.gitignore` if needed).

## Organization

Ask the user how their repo is structured before designing the env layout.

**Single project:** one primary `.env.schema` at the repo root is usually enough.

**Monorepo / multi-app:** consider a layered layout:

1. **Shared root config** — common items (shared service URLs, org-wide defaults, `@currentEnv`) in the root `.env.schema`
2. **Package/app schemas** — each app, package, or service has its own `.env.schema` for app-specific items
3. **`@import` the shared config** — pull root (or shared) schema into each app:

```env-spec
# apps/web/.env.schema
# @import("../../.env.schema")
# ---
APP_PUBLIC_URL=
```

4. **Cross-package imports** — when one app depends on another's config surface, `@import` from that package's schema (keep imports explicit; avoid circular imports)

Discuss with the user: which values belong at the root vs per-package, which environments they use, and whether any packages should share imported fragments rather than duplicating keys.

See https://varlock.dev/guides/import/

## Plugins and integrations

Use this when **adding Varlock to a new app/service** or **migrating an existing one**. Ask the user about their stack, secret store, and deployment target before changing code or schema.

### Integrations (framework / runtime)

Pick the official integration that matches the project — do not guess. Check https://varlock.dev/integrations/overview/ and the specific guide for their framework (Next.js, Vite, Astro, Bun, Cloudflare, Expo, etc.).

Typical steps:

1. Confirm `varlock` is installed (`varlock init --agent` or existing dependency)
2. Follow the integration guide for build/dev wiring, generated types, and any required config files
3. Prefer the integration's recommended entry point (`varlock/auto-load`, Vite plugin, framework plugin, etc.) over ad-hoc `process.env` usage
4. Use `varlock run -- <cmd>` for scripts/tools the integration does not cover (migrations, one-off CLIs, CI commands)

**Migrating from dotenv:** replace `dotenv/config` or `dotenvx run` with the Varlock equivalent from https://varlock.dev/guides/migrate-from-dotenv/ — then move config into `.env.schema`.

**Non-JS apps/services:** use `varlock run` or pipe `varlock load --format shell` — see https://varlock.dev/integrations/other-languages/

### Plugins (secret providers)

When secrets should come from an external provider (1Password, AWS, Doppler, Vault, etc.) rather than plaintext local files:

1. Ask which provider the user already uses
2. Install the matching `@varlock/*` plugin package in JS projects (standalone binary can pin a fixed version in schema)
3. Add `# @plugin(@varlock/…-plugin)` to `.env.schema` (once, globally)
4. Apply any plugin-specific root decorators for initialization (e.g. `@initOp(...)`)
5. Use the plugin's resolver functions / types in schema items — keep values in tracked env files declarative, not hardcoded secrets

See plugin list and setup: https://varlock.dev/guides/plugins/ and https://varlock.dev/plugins/overview/

After adding an integration or plugin, run `varlock load --agent` to confirm the schema resolves and validates.

## Setup

1. Run `varlock init --agent` to create or review `.env.schema`
2. Review the generated schema with the user — init heuristics are a draft, not final
3. Install this skill with [skills](https://github.com/vercel-labs/skills): `npx skills add dmno-dev/varlock`

Update later with `npx skills update varlock`.

## Schema checklist

After init or when editing `.env.schema`:

1. Review auto-generated items — heuristics are not final
2. Add description comments where names are not self-explanatory
3. Set `@type` only when not a plain string (omit `@type=string`)
4. Mark `@required` / `@optional` (or adjust root `@defaultRequired`)
5. Confirm `@sensitive` on secrets, keys, tokens, and credentials with the user
6. Move useful values to `@example`; delete dummy placeholders
7. Add `@docs()` links where helpful
8. Remove redundant values from other `.env` files after defaults move into the schema

Use root decorators (`@defaultRequired`, `@defaultSensitive`, `@generateTypes`) to reduce repetition — only override at item level when needed.

## Validation loop

After schema changes:

```bash
varlock load --agent
```

Fix schema and tracked env files based on validation errors. Do not patch gitignored `.local` value files to silence schema errors — ask the user to update secrets locally.

## CLI quick reference

| Command | Use when |
|---------|----------|
| `varlock init --agent` | Setting up varlock non-interactively |
| `varlock load --agent` | Validating config safely in agent logs |
| `varlock load` | Showing human-readable output to the user |
| `varlock run -- <cmd>` | Injecting resolved env into a process |
| `varlock scan` | Checking for leaked secrets in source code |
| `varlock encrypt` | Encrypting sensitive plaintext values in env files |

## Advanced

- Multiple environments: https://varlock.dev/guides/environments/
- Split large schemas with `@import`: https://varlock.dev/guides/import/
- Device-local encryption: https://varlock.dev/guides/local-encryption/

## Docs

Use the Varlock Docs MCP if installed in your AI tool. Otherwise start with https://varlock.dev/guides/schema
