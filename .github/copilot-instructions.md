# Copilot PR code review (security)

**Scope:** Focus on **code** security. Copilot does not review dependency manifests or lockfiles; rely on Dependabot, CodeQL, and the dependency-review workflow for supply chain.

## Security checklist (changed lines)

1. **Secrets:** No hardcoded API keys, tokens, passwords, or private URLs. Preserve redaction and leak prevention for sensitive env values.
2. **Injection / parsing:** Safe handling of user-controlled strings in @env-spec parsing and loaders; avoid `eval` / `new Function` on untrusted input.
3. **Process execution:** `exec` / `spawn` / shell (secret plugins, integrations): avoid shell injection; validate arguments; no untrusted paths.
4. **Filesystem:** No path traversal or arbitrary read/write from external input.
5. **Trust boundaries:** Document what untrusted config can do; avoid unsafe defaults.
6. **Risky APIs:** Flag unsafe `child_process`, `vm`, or deserialization from untrusted data.
7. **Crypto:** Prefer standard libraries; avoid ad-hoc cryptography.
8. **AI safety:** No prompt injection or other unsafe patterns that might allow exfiltration of secrets. 

**Varlock:** Loaders, CLI, `packages/plugins`, and MCP integrations are high impact.

---

# Copilot Instructions for Varlock

🚨 MANDATORY WORKFLOW STEPS - See [COPILOT_RULES.md](COPILOT_RULES.md) for important checklist of tasks to complete before committing any work.

## Project Overview

Varlock is a tool that adds declarative schema to `.env` files using `@env-spec` decorator comments. It provides validation, coercion, type safety, protection for sensitive values, and flexible multi-environment management.

### Key Features
- 🛡️ Validation, coercion, type safety with IntelliSense
- 🔏 Protection for sensitive config values (log redaction, leak prevention)
- 🌐 Flexible multi-environment management
- 💫 Composition of values, functions, load from external sources

## Repository Structure

This is a **monorepo** managed with **bun workspaces** and **Turborepo**.

### Main Packages
- `packages/env-spec-parser` - Parser for the @env-spec language (uses PEG.js grammar)
- `packages/varlock` - CLI tool and library for loading `.env` files with validation
- `packages/varlock-website` - Documentation website (Astro-based)
- `packages/vscode-plugin` - VSCode extension for @env-spec language support
- `packages/varlock-github-action` - GitHub Action for Varlock
- `packages/varlock-docs-mcp` - Model Context Protocol (MCP) server for docs

### Integrations
- `packages/integrations/nextjs` - Next.js integration
- `packages/integrations/vite` - Vite integration
- `packages/integrations/astro` - Astro integration

### Utilities
- `packages/utils` - Shared utility functions
- `packages/plugins` - Shared plugins

## Tech Stack

### Core Technologies
- **Node.js**: >= 22 (specified in engines)
- **Package Manager**: bun
- **TypeScript**: 5.9.3 (catalog version)
- **Build Tool**: tsup (for libraries), Turborepo (for orchestration)
- **Testing**: Vitest 4.0.6
- **Linting**: ESLint 9+ with TypeScript-ESLint, Stylistic plugins

### Framework-Specific
- **Website**: Astro (for varlock-website)
- **Bundlers**: Vite 7.1.12, tsup 8.5.0

## Development Workflows

### Installation & Setup
```bash
bun install          # Install dependencies
bun run build:libs       # Build all libraries (excludes website)
bun run build            # Build everything including website
```

### Development
```bash
bun run dev              # Start dev servers for all packages (parallel)
```

### Testing
```bash
bun run test             # Run tests in watch mode
bun run test:ci          # Run tests once (CI mode)
```

### Linting
```bash
bun run lint             # Run ESLint
bun run lint:fix         # Run ESLint with auto-fix
```
**🚨 CRITICAL**: Always run `bun run lint:fix` before completing any task!

### Versioning (bumpy)
```bash
bun run bumpy:add        # Add a new changeset (interactive)
```
**🚨 CRITICAL**: Always add a changeset for package changes that affect users!

#### Isolated bump types
Bumpy natively supports `minor-isolated` and `patch-isolated` bump types. These suppress dependency propagation — the package gets bumped but dependents are not automatically bumped. Use **`minor-isolated`** for minor bumps that don't affect the library API consumed by dependents (e.g., CLI-only features in `varlock`). This is the most common use case — because all packages are still on `0.x`, `^0.y.z` ranges treat minor bumps as out-of-range, which would otherwise cascade bumps to all dependents. `patch-isolated` exists but is rarely needed since patch bumps stay within `^` ranges on `0.x`. `major-isolated` is not supported — major bumps must propagate to keep semver ranges valid.

#### Non-interactive changeset creation (AI/CI)
```bash
bumpy add --packages "varlock:minor,@varlock/utils:patch" --message "description" --name "changeset-name"
```

## Coding Standards

### 🚨 MANDATORY PRE-COMPLETION CHECKLIST
Before marking any task as complete, you MUST:
- [ ] Run `bun run lint:fix` and resolve any remaining errors
- [ ] Add a changeset with `bun run bumpy:add` (unless internal-only change)
- [ ] Verify build passes with `bun run build:libs`

### Style & Formatting
- **Indentation**: 2 spaces (enforced by .editorconfig)
- **Line endings**: LF (Unix-style)
- **Charset**: UTF-8
- **Final newline**: Required
- **ESLint config**: Uses @stylistic/eslint-plugin with Airbnb style guide
- **TypeScript**: Strict mode enabled

### Best Practices
1. **Use ES Modules**: All packages use `"type": "module"` in package.json
2. **Node compatibility**: Minimum Node.js 22.x
3. **Export structure**: Use TypeScript `exports` field in package.json with `ts-src`, `types`, and `default` conditions
4. **Type safety**: Always provide TypeScript types
5. **Testing**: Write tests using Vitest, following existing patterns
6. **Monorepo awareness**: Dependencies between packages should be properly declared

### File Organization
- Source code in `src/` directory
- Tests in `test/` directory or co-located with source
- Build output in `dist/` directory
- TypeScript configs: `tsconfig.json` (and variants like `tsconfig.build.json`)
- Build configs: `tsup.config.ts` for most packages

## Build & Test Commands

### Turborepo Tasks
The project uses Turborepo with the following task configurations:
- `build`: Builds the package, depends on `^build` (dependencies built first)
- `test:ci`: Runs tests in CI mode
- `dev`: Persistent dev server (no caching)
- `lint`: Linting task

### Important Environment Variables
- `WORKERS_CI_BRANCH`: CI branch information
- `APP_ENV`: Application environment
- `BUILD_TYPE`: Type of build

## CI/CD

### GitHub Actions Workflows
- **test.yaml**: Main CI workflow (lint, build, test)
- **release.yaml**: Release workflow using bumpy
- **release-preview.yaml**: Preview release workflow
- **binary-release.yaml**: Binary release workflow
- **pr-labeler.yaml**: Auto-labels PRs
- **request-copilot-review.yml**: Requests Copilot code review for **fork** PRs only (external contributors)

### CI Steps
1. ESLint check
2. Build libraries (`bun run build:libs`)
3. Run tests (`bun run test:ci`)

## Special Considerations

### @env-spec Language
- Custom DSL for environment variable schemas
- Parser built with PEG.js (grammar in `packages/env-spec-parser/grammar.peggy`)
- JSDoc-style comment syntax
- Supports types, validation, defaults, sensitive flags, etc.

### Security
- Sensitive values are redacted in logs
- Leak prevention mechanisms
- Support for secret fetching from external sources (e.g., 1Password via `exec()`)

### MCP (Model Context Protocol)
- Varlock provides MCP servers for AI assistance
- HTTP and SSE endpoints available at docs.mcp.varlock.dev

## Common Patterns

### Adding a New Package
1. Create package directory under `packages/`
2. Add `package.json` with proper exports, scripts, and dependencies
3. Add `tsconfig.json` extending from root config
4. Add `tsup.config.ts` for build configuration
5. Ensure package is included in bun workspaces (root `package.json` workspaces field)
6. Add build/test scripts consistent with other packages

### Adding a New Integration
1. Create under `packages/integrations/<framework-name>`
2. Follow existing integration patterns (see nextjs, vite, astro)
3. Provide clear installation and usage docs in README
4. Export both runtime and build-time utilities if needed

### Modifying the Parser
1. Update grammar in `packages/env-spec-parser/grammar.peggy`
2. Rebuild parser (handled by build process)
3. Update types in TypeScript
4. Add tests in `packages/env-spec-parser/test/`

## Documentation

- Main docs: https://varlock.dev
- Docs source: `packages/varlock-website/src/content/docs/`
- API docs are generated from TypeScript source
- Examples repo: https://github.com/dmno-dev/varlock-examples

## Debugging

Enable source maps during development:
```bash
export NODE_OPTIONS=--enable-source-maps
```

## Community

- Discord: https://chat.dmno.dev (use #contribute channel for development questions)
- Issues: GitHub issues in this repository
- Code of Conduct: See CODE_OF_CONDUCT.md
- Contributing Guide: See CONTRIBUTING.md
