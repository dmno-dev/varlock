# Project conventions

## Package manager

- This repo uses **Bun** as the package manager (`bun install`, `bun run`, etc.)
- Workspace deps use `workspace:*` protocol
- Use catalog for any potentially common dependencies
- CI workflows use `bun run` to execute scripts and `bunx` for one-off commands

## Scripts

- Write any scripts which may end up being saved in **TypeScript** (`.ts`), not JavaScript
  - throwaway/one-off code is fine in JS
- Execute scripts using **`bun run`**, not `node`
  - e.g. `bun run scripts/release-preview.ts`
  - Bun runs `.ts` files natively — no compile step needed
- Scripts in `scripts/` at the repo root are monorepo-level utilities, while specific packages may have their own `scripts` folder

## Binary builds

- The varlock CLI binary is built using `bun build --compile` (not Node SEA or pkg)
- `bun run --filter varlock build:binary` builds a local dev binary for the current platform at `packages/varlock/dist-sea/varlock`
- `packages/varlock/scripts/build-binaries.ts` builds cross-platform release binaries (or use `--current-platform` for a single local binary)

## Testing

- Unit/integration tests use **Vitest**
- Smoke tests live in `smoke-tests/` and test the CLI end-to-end
- Binary-specific tests in `smoke-tests/tests/binary.test.ts` require the SEA binary to be built first

## Linting

- Run **`bun run lint:fix`** from the repo root after completing a significant chunk of work (new feature, refactor, bug fix, etc.)
- The linter uses ESLint with `@stylistic` and other plugins — auto-fix handles most formatting issues
- Do not leave lint errors unresolved; fix any that `--fix` cannot handle automatically

## Sandbox environment (GitHub Copilot Agent)

The Copilot Agent sandbox uses a MITM proxy that **corrupts Brotli-encoded npm registry responses**, causing `bun install` to fail with `HTTPError` or `Unterminated string literal` errors.

### Installing bun

Bun is not pre-installed. Install it first:

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.9"
export PATH="$HOME/.bun/bin:$PATH"
```

### Running `bun install`

Use the local npm proxy script to bypass the Brotli corruption issue:

```bash
# 1. Start the proxy in the background (redirecting its output)
python3 scripts/sandbox-npm-proxy.py >> /tmp/proxy.log 2>&1 &

# 2. Install dependencies using the proxy
BUN_CONFIG_REGISTRY="http://127.0.0.1:4873" bun install --frozen-lockfile
```

The proxy (`scripts/sandbox-npm-proxy.py`) re-fetches npm packages using gzip instead of Brotli, avoiding the MITM proxy corruption. The `--frozen-lockfile` flag ensures bun uses the existing `bun.lock` (resolving `catalog:` references from there) rather than re-resolving from scratch.

### Running the linter

After `bun install`, you can run the linter normally:

```bash
bun run lint       # check
bun run lint:fix   # auto-fix
```
