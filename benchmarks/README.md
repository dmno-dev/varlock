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

Install methods are three distinct runtimes, not three package managers: `npm` installs and runs under **node**, `bun` installs and runs under **bun**, `sea` is the compiled standalone binary.

## Reading the results

Each run prints a **Deltas** table before the raw numbers. The deltas are the point of the suite: absolute wall times on a shared CI runner are not comparable between runs, but the difference between two scenarios measured back to back within one run is.

A delta smaller than the standard deviation of either side is tagged `(within noise)` and should not be read as a change.

Every scenario records `wallMsMin`, `wallMsMedian`, `wallMsP95`, `wallMsStdDev` and `iterations`. Prefer **min** and **stddev**: min is the least noise-sensitive statistic for this kind of measurement, and p95 collapses onto the max at the iteration counts used here.

`meta.notes` lists anything that was skipped or degraded (missing SEA binary, no Go toolchain, telemetry not measurable). Nothing is dropped silently.

## Telemetry

Telemetry-on scenarios exist to measure what the telemetry code path costs. **They never send real telemetry.** The suite starts a local mock collector and points varlock at it with `VARLOCK_POSTHOG_HOST`, which keeps the code path intact (payload building, the exit hook that waits on the in-flight request) without injecting synthetic events into product analytics, and without making the timings depend on network latency to the real collector.

Before running any telemetry-on scenario the suite probes whether the version under test honours that override. If it does not (versions published before the override existed), those scenarios are skipped and a note is recorded.

## Local usage

```bash
bun run bench
```

```bash
bun run bench -- --version 1.13.0 --sea-path ./packages/varlock/dist-sea/varlock
```

```bash
bun run bench -- --only cli-load,cli-run --iterations 3
```

```bash
bun run bench -- --skip-install --only cli-load
```

The first form benchmarks the latest published varlock. The others pin a version and add a local SEA binary, restrict to a subset of scenario groups for faster iteration, and reuse the npm/bun installs left in `benchmarks/.work` by a previous run.

From this directory, `bun install` first and then use `bun run bench` the same way.

Integration benches drive [`FrameworkTestEnv`](../framework-tests/harness/fixture-env.ts) with `usePublished: true` so they install from npm (not packed workspace tarballs) while reusing the same Next/Vite templates as framework CI.

Results are written to `results/<iso>-varlock@<ver>-<runid>.json`. CI commits those files; local runs leave them untracked unless you commit them yourself.

## CI

Workflow: [`.github/workflows/benchmarks.yaml`](../.github/workflows/benchmarks.yaml)

- **Manual:** Actions → Benchmarks → Run workflow (optional version / scenario filter)
- **After publish:** [`release.yaml`](../.github/workflows/release.yaml) dispatches this workflow once SEA binaries are uploaded for `varlock@<version>`

The job installs from npm, downloads `varlock-linux-x64.tar.gz` when present, runs the suite, and commits the new JSON under `results/` with `[skip ci]` so the commit does not retrigger release/CI. The suite waits for the version to appear on npm itself, so a release-triggered run can start before the registry has caught up.

v1 is informational only (no regression gate). Suite failures still fail the workflow.

## Known gaps

- **Linux/x64 only.** The SEA binary ships for macOS and Windows too, but nothing measures them. The non-Linux RSS sampling path (which shells out to `ps` once per sample, perturbing the timings it measures) is therefore only exercised by local runs.
- **The `cli-load` fixture has nothing worth caching.** Cold vs warm is now a valid comparison in CI (`_VARLOCK_CACHE_KEY` forces the on-disk cache, which CI would otherwise skip in favour of a per-process memory cache), but the fixture is all static literals, so both arms measure roughly the same work. Exercising the cache meaningfully needs a fixture with expensive resolvers, e.g. a plugin-backed or `exec()` value.
- **No regression gate and no cross-run comparison tooling.** Results accumulate in `results/` but nothing reads the history yet.
