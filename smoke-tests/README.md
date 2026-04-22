# Varlock Smoke Tests

Cross-platform smoke tests for varlock using Vitest.

## Running Tests

```bash
# Run all smoke tests
bun test

# Watch mode for development
bun run test:watch

# From repo root
bun run smoke-test
```

## Test Structure

- **tests/cli.test.ts** - CLI commands (--help, load, formats)
- **tests/redaction.test.ts** - Log redaction in various scenarios
- **tests/runtime.test.ts** - Runtime compatibility (Node, Bun, error handling)
- **tests/frameworks.test.ts** - Framework integrations (Astro, Next.js)
- **helpers/** - Shared utilities for running varlock commands

## CI/CD

The GitHub Actions workflow (`.github/workflows/smoke-test.yaml`) runs these tests on:
- Ubuntu, macOS, and Windows
- Only on release PRs (created by bumpy)

The workflow:
1. Builds libraries once on Ubuntu (cached with Turbo)
2. Uploads dist artifacts
3. Each platform downloads artifacts and runs `bun test`

This approach is fast because JavaScript output is platform-independent - we only need to test the runtime behavior on each platform.
