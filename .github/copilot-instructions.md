# Copilot PR code review (security)

**Scope:** Focus on **code** security. Copilot does not review dependency manifests or lockfiles; rely on Dependabot, CodeQL, and the dependency-review workflow for supply chain.

## Security checklist (changed lines)

1. **Secrets:** No hardcoded API keys, tokens, passwords, or private URLs. Preserve redaction and leak prevention for sensitive env values.
2. **Injection / parsing:** Safe handling of user-controlled strings in @env-spec parsing and loaders; avoid `eval` / `new Function` on untrusted input.
3. **Process execution:** `exec` / `spawn` / shell (secret plugins, integrations): avoid shell injection; validate arguments; no untrusted paths.
4. **Filesystem:** No path traversal or arbitrary read/write from external input.
5. **Trust boundaries:** Document what untrusted config can do; avoid unsafe defaults.
6. **Risky APIs:** Flag unsafe `child_process`, `vm`, or deserialization from untrusted data.
7. **Crypto:** Prefer standard libraries; avoid ad-hoc cryptography.
8. **AI safety:** No prompt injection or other unsafe patterns that might allow exfiltration of secrets.

**Varlock:** Loaders, CLI, `packages/plugins`, and MCP integrations are high impact.

---

# Copilot Instructions for Varlock

Varlock adds declarative schema to `.env` files using `@env-spec` decorator comments — validation, coercion, type safety, redaction/leak prevention for sensitive values, and multi-environment management.

All project conventions live in [AGENTS.md](../AGENTS.md) — repo structure, bun/workspace usage, scripts, testing, versioning (bumpy changesets), linting, and branch/PR rules. Follow it.

Quick reference:

```bash
bun install              # install dependencies
bun run build:libs       # build all libraries (excludes website)
bun run test:ci          # run tests once (CI mode)
bun run lint:fix         # lint with auto-fix — run before completing any task
```

Before finishing any task: run `bun run lint:fix`, verify `bun run build:libs` passes, and add a bumpy changeset if publishable packages changed (see AGENTS.md for details).
