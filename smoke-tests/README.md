# Varlock Smoke Tests

Cross-platform smoke tests for varlock using Vitest.

These run against varlock the way a real user would install it — this is a separate
**pnpm** workspace that depends on `varlock` (a workspace link locally, a packed `.tgz`
in CI) and invokes the installed CLI entrypoint, not the source tree.

## Running Tests

This package uses **pnpm** (not bun — see `packageManager` in `package.json`). Install
its deps first, then run vitest:

```bash
# From this directory
pnpm install
pnpm test            # run all smoke tests
pnpm run test:watch  # watch mode

# From the repo root (assumes deps are already installed here)
bun run smoke-test
```

## Test Structure

- **tests/cli.test.ts** - CLI commands (help, load, formats, printenv/explain/scan/audit, run)
- **tests/cache.test.ts** - `cache()` end-to-end and the `varlock cache` command
- **tests/redaction.test.ts** - Log redaction in various scenarios
- **tests/runtime.test.ts** - Runtime compatibility (Node, Bun, error handling)
- **tests/frameworks.test.ts** - Framework integrations (Astro, Next.js)
- **tests/plugin.test.ts** - Plugin resolution end-to-end
- **tests/monorepo-typegen.test.ts** - Type generation in a monorepo layout
- **tests/binary.test.ts** / **tests/binary-plugin.test.ts** - SEA binary (skipped unless the binary is built)
- **helpers/** - Shared utilities for running varlock (`run-varlock.ts`, `run-varlock-binary.ts`)

## CI/CD

The GitHub Actions workflow (`.github/workflows/smoke-test.yaml`) runs on Ubuntu, macOS,
and Windows, but **not on every PR**. To avoid expensive multi-platform runs, the tests
only execute on:

- Release PRs (created by bumpy, titled "Versioned release")
- PRs labeled `smoke-tests`
- Manual `workflow_dispatch` runs

To exercise smoke tests on a regular feature PR, add the `smoke-tests` label.

The workflow:
1. Builds libraries once on Ubuntu (cached with Turbo) and packs them
2. Uploads the packed artifacts
3. Each platform installs the packed packages with `pnpm install` and runs `pnpm test`

This is fast because JavaScript output is platform-independent — we only need to verify
runtime behavior on each platform.
