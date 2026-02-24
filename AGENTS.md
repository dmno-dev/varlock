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
