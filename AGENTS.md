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
- `bun run --filter varlock test:binary:local` builds the local binary and runs a smoke `load` check (WSL-aware helper copy)
- `bun run --filter varlock pack:local` builds + packs a local tarball and prints a ready-to-paste `file:` dependency

## Testing

- Unit/integration tests use **Vitest**
- Smoke tests live in `smoke-tests/` and test the CLI end-to-end
- Binary-specific tests in `smoke-tests/tests/binary.test.ts` require the SEA binary to be built first

## Versioning & releases

- This monorepo uses **bumpy** (`@varlock/bumpy`) for version management
- Changeset files live in `.bumpy/` and are created with `bunx @varlock/bumpy add` (or `bun run bumpy:add`)
- Standard bump types: `major`, `minor`, `patch`
- **Isolated bump types**: `minor-isolated` and `patch-isolated` are natively supported
  - These suppress dependency propagation — the package itself gets bumped but dependents are **not** automatically bumped
  - Use **`minor-isolated`** for minor bumps that don't affect the library API consumed by dependents (e.g., CLI-only features in `varlock` that plugins/integrations don't depend on). This is the most common use case — because all packages are still on `0.x`, `^0.y.z` ranges treat minor bumps as out-of-range, which would otherwise cascade bumps to all dependents.
  - `patch-isolated` exists but is rarely needed — patch bumps on `0.x` stay within `^` ranges and don't cascade
  - `major-isolated` is intentionally **not** supported (major bumps must propagate to keep semver ranges valid)
- Non-interactive changeset creation (for CI/AI): `bumpy add --packages "pkg:minor" --message "description" --name "changeset-name"`
- Bump files are only required when publishable packages have changed (based on `changedFilePatterns` in `.bumpy/_config.json`). Changes to CI workflows, root config files, scripts, docs, etc. do **not** require a bump file — bumpy's pre-push hook will not block in that case.

## Linting

- Run **`bun run lint:fix`** from the repo root after completing a significant chunk of work (new feature, refactor, bug fix, etc.)
- The linter uses ESLint with `@stylistic` and other plugins — auto-fix handles most formatting issues
- Do not leave lint errors unresolved; fix any that `--fix` cannot handle automatically
