# Copilot Instructions for Varlock

## Project Overview

Varlock is a tool that adds declarative schema to `.env` files using `@env-spec` decorator comments. It provides validation, coercion, type safety, protection for sensitive values, and flexible multi-environment management.

### Key Features
- 🛡️ Validation, coercion, type safety with IntelliSense
- 🔏 Protection for sensitive config values (log redaction, leak prevention)
- 🌐 Flexible multi-environment management
- 💫 Composition of values, functions, load from external sources

## Repository Structure

This is a **monorepo** managed with **pnpm workspaces** and **Turborepo**.

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
- **Package Manager**: pnpm >= 10 (enforced via preinstall script)
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
pnpm install          # Install dependencies
pnpm build:libs       # Build all libraries (excludes website)
pnpm build            # Build everything including website
```

### Development
```bash
pnpm dev              # Start dev servers for all packages (parallel)
```

### Testing
```bash
pnpm test             # Run tests in watch mode
pnpm test:ci          # Run tests once (CI mode)
```

### Linting
```bash
pnpm lint             # Run ESLint
pnpm lint:fix         # Run ESLint with auto-fix
```

### Changesets
```bash
pnpm changeset:add    # Add a new changeset
pnpm changeset:empty  # Add an empty changeset
pnpm changeset:version # Version packages and update changelogs
pnpm changeset:publish # Build and publish packages
```

## Coding Standards

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
- **release.yaml**: Release workflow using changesets
- **release-preview.yaml**: Preview release workflow
- **binary-release.yaml**: Binary release workflow
- **pr-labeler.yaml**: Auto-labels PRs

### CI Steps
1. ESLint check
2. Build libraries (`pnpm run build:libs`)
3. Run tests (`pnpm run test:ci`)

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
5. Ensure package is included in pnpm workspace (`pnpm-workspace.yaml`)
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
