# Project conventions

## Repo structure

This is a monorepo managed with bun workspaces and Turborepo:

- `packages/env-spec-parser` — parser for the @env-spec language (PEG.js grammar in `grammar.peggy`)
- `packages/varlock` — the main package: CLI + library for loading/validating `.env` files
- `packages/varlock-website` — docs site (Astro); docs content lives in `src/content/docs/`
- `packages/vscode-plugin` — VSCode extension for @env-spec language support
- `packages/integrations/*` — framework integrations (nextjs, vite, astro, ...)
- `packages/utils`, `packages/plugins` — shared internals
- `packages/varlock-docs-mcp` — docs MCP server for external varlock users; do **not** use it to look things up while working on this repo — read the docs source directly

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
- Non-interactive changeset creation (for CI/AI): `bumpy add --packages "pkg:minor" --message "description" --name "changeset-name"`
- Bump files are only required when publishable packages have changed (based on `changedFilePatterns` in `.bumpy/_config.json`). Changes to CI workflows, root config files, scripts, docs, etc. do **not** require a bump file — bumpy's pre-push hook will not block in that case.
- Write changeset descriptions for end users, and keep them short

## Branches & pull requests

- Branch names must be meaningful — a short kebab-case description of the change (e.g. `fix-cf-fifo-secret-concat`, `vite-plugin-hmr`). Never push an auto-generated session/worktree branch name (e.g. `claude/dreamy-jones-a79c22`); rename it first with `git branch -m <meaningful-name>`
- Do **not** add AI attribution to PRs or commits — no "Authored by Claude" / "Generated with Claude Code" lines in PR descriptions, and no `Co-Authored-By: Claude` commit trailers
- Keep PR descriptions concise: what changed and why. Don't mention linting passing or bump files being added — those are enforced by hooks and expected, not news
- When pushing new commits to an open PR, update the PR description if the changes alter what it says
- If a change affects user-facing behavior, update the docs in `packages/varlock-website/src/content/docs/` (guides and/or reference) in the same PR

## Documentation

Docs content lives in `packages/varlock-website/src/content/docs/` (`.mdx`). When writing or editing docs prose, keep the tone plain and direct, like an engineer wrote it:

- No em dashes (`—`). Rewrite into separate sentences, commas, colons, or parentheses instead. Do not swap in a spaced hyphen (` - `). (En dashes for genuine numeric ranges like `15.0–15.4` are fine.)
- Avoid marketing and AI-flavored filler: `seamless`, `comprehensive`, `powerful`, `robust`, `leverage`, `out of the box`, `by design`, `effortless`, `unlock` (metaphorical), "whether you need X, Y, or Z", "instead of wrestling with", and similar. Say what the thing does plainly.
- Be concise, but never at the cost of completeness. Keep every flag, command, caveat, and link a user or their agent needs to stay unblocked.
- Never edit code fences, `ansi`/`diff` blocks, generated fixtures, frontmatter structure, or MDX component markup for tone. Prose only.
- Run `bun run --filter varlock-website astro build` to confirm the docs still build after non-trivial edits.

## Linting

- Run **`bun run lint:fix`** from the repo root after completing a significant chunk of work (new feature, refactor, bug fix, etc.)
- The linter uses ESLint with `@stylistic` and other plugins — auto-fix handles most formatting issues
- Do not leave lint errors unresolved; fix any that `--fix` cannot handle automatically
