# Varlock benchmarks

Release benchmarking suite for **memory footprint**, **execution time**, and **added latency** (redaction / leak prevention).

Runs against **published** npm packages (and optionally the linux SEA binary), not workspace links. Results are committed under [`results/`](results/) so trends are visible in git history.

## What it measures

| Group | Scenarios |
|-------|-----------|
| `cli-load` | `load` cold (`--clear-cache`) and warm, for npm / bun / SEA, with **telemetry on/off** |
| `cli-run` | Bare node baseline; `varlock run` wrap with **telemetry on/off**; stdout redaction on vs off (telemetry off) |
| `cli-scan-audit` | Light `scan` and `audit` coverage (telemetry off) |
| `integration-next` | Uses [`framework-tests/frameworks/nextjs`](../framework-tests/frameworks/nextjs): `next build` baseline vs varlock with **telemetry on/off**; request latency for `preventLeaks` and `redactLogs` |
| `integration-vite` | Uses [`framework-tests/frameworks/vite`](../framework-tests/frameworks/vite): `vite build` baseline vs varlock with **telemetry on/off**; request latency for `preventLeaks` and `redactLogs` |
| `lang-python` | `load`+codegen and `varlock run -- python3` |
| `lang-go` | `load`+codegen and `varlock run` of a built Go binary |

## Local usage

```bash
# From repo root (latest published varlock)
bun run bench

# Specific version + local SEA binary
bun run bench -- --version 1.13.0 --sea-path ./packages/varlock/dist-sea/varlock

# Subset of scenario groups (faster iteration)
bun run bench -- --only cli-load,cli-run --iterations 3

# Reuse prior npm/bun installs under benchmarks/.work
bun run bench -- --skip-install --only cli-load
```

Or from this directory:

```bash
bun install
bun run bench -- --version latest --only cli-load
```

Integration benches drive [`FrameworkTestEnv`](../framework-tests/harness/fixture-env.ts) with `usePublished: true` so they install from npm (not packed workspace tarballs) while reusing the same Next/Vite templates as framework CI.

Results are written to `results/<iso>-varlock@<ver>-<runid>.json`. CI commits those files; local runs leave them untracked unless you commit them yourself.

## CI

Workflow: [`.github/workflows/benchmarks.yaml`](../.github/workflows/benchmarks.yaml)

- **Manual:** Actions → Benchmarks → Run workflow (optional version / scenario filter)
- **After publish:** [`release.yaml`](../.github/workflows/release.yaml) dispatches this workflow once SEA binaries are uploaded for `varlock@<version>`

The job installs from npm, downloads `varlock-linux-x64.tar.gz` when present, runs the suite, and commits the new JSON under `results/` with `[skip ci]` so the commit does not retrigger release/CI.

v1 is informational only (no regression gate). Suite failures still fail the workflow.
