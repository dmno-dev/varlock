# Framework Tests

Integration tests that verify varlock works correctly with real framework build pipelines. Each test creates an isolated temporary project, installs packed varlock packages from source, runs a real build, and asserts on the output.

## Running tests

From this directory (`framework-tests/`):

```sh
# Run all framework tests
bun run test

# Run tests for a specific framework
bun run test:expo
bun run test:nextjs

# Watch mode (re-runs on file changes)
bun run test:watch

# Re-pack varlock packages after making source changes
bun run repack
```

Or from the repo root:

```sh
bun run --filter varlock-framework-tests test
```

## How it works

### Test harness (`harness/`)

The shared harness provides `FrameworkTestEnv`, which manages the full lifecycle:

1. **Pack** — varlock packages are built and packed into `.tgz` tarballs (cached in `.packed/`; run `bun run repack` to refresh after source changes)
2. **Setup** — a temp project is created in `.test-projects/`, deps are installed via pnpm
3. **Scenario** — template files are copied, a build command runs, and output is asserted
4. **Teardown** — temp project is removed (set `KEEP_TEST_DIRS=1` to preserve for debugging)

### Adding a new framework

Create a directory under `frameworks/<name>/` with:

```
frameworks/<name>/
  <name>.test.ts          # Test file using FrameworkTestEnv
  files/
    _base/                # Files copied into every scenario (config, build scripts, etc.)
    schemas/              # .env.schema and env override files
    pages/                # Page/component templates swapped per scenario
```

If the framework needs a new varlock integration package, register it in `harness/pack.ts`.

### Test scenarios

Each scenario uses `describeScenario()` which:
- Copies template files into the project (merging fixture defaults with scenario overrides)
- Runs a build command (auto-prefixed with the package manager)
- Creates individual vitest tests for each `fileAssertion` and `outputAssertion`

### Environment variables

| Variable | Description |
|---|---|
| `KEEP_TEST_DIRS` | Set to `1` to preserve temp project dirs after tests |
| `REPACK` | Set to `1` to force re-packing varlock tarballs (otherwise cached) |

## Current frameworks

- **Next.js** — tests multiple versions (14, 15, 16) and bundlers (webpack, turbopack), verifying env injection, leak detection, log redaction, and sourcemap scrubbing
- **Expo** — tests the babel plugin transform pipeline, verifying static replacement of public vars, protection of sensitive vars, and correct handling of server (+api) routes
