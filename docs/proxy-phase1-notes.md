# Proxy Mode Phase 1 Notes

## What We Learned

- `--proxy` placeholder injection is useful, but not sufficient on its own.
- In proxied child processes, nested `varlock` invocations can potentially recover raw secrets unless explicitly guarded.
- For the current risk model (preventing accidental/bad agent behavior, not defeating a determined local attacker), explicit command guardrails are a practical first step.
- For coding agents, reading and editing `.env.schema` is useful and should stay possible.

## Phase 1 Goal

Make proxied runs safer by default by blocking obvious raw-secret recovery paths while preserving useful debugging workflows.

## Phase 1 Safety Model

- Treat proxied child process as untrusted for secret retrieval.
- Allow safe inspection commands.
- Deny commands/formats that can reveal plaintext secrets.
- Log and clearly explain blocked actions.

## Immediate Guardrails

- Add a proxied-child marker env var in `varlock run --proxy`.
- In proxied context, deny nested:
  - `varlock run`
  - `varlock printenv`
  - `varlock reveal`
- In proxied context, restrict `varlock load` output:
  - Allow default `pretty` output.
  - Allow `json` / `json-full` only with `--agent`.
  - Deny `env` / `shell` formats.
- In proxied context, verify schema fingerprint for `varlock load`:
  - Fingerprint is captured at proxy start from approved schema shape.
  - If schema changes during run, proxied `load` is blocked until proxy restart/approval.

## Known Limitation (Important)

If the agent edits `.env.schema` to downgrade an item from sensitive to non-sensitive, a schema fingerprint mismatch now blocks proxied `load`; full approval workflows are still needed so changes can be intentionally reviewed and activated.

## Planned Follow-up

Introduce an explicit approval gate for schema changes before they affect active proxy behavior:

1. Agent can edit schema -> state becomes `pending`.
2. Proxy keeps using last approved policy.
3. Native macOS binary presents review/approval UI.
4. Only approved changes are activated (reload policy snapshot).

This avoids silent sensitivity downgrades taking effect inside proxied runs.

## macOS-First Approach

- Trusted approver: Swift/native binary (menu bar + modal).
- Untrusted actor: proxied child process.
- CLI blocks and waits for binary approval for sensitive operations in later phase extensions.

## Long-Term Direction

- Phase 2: local isolated broker mode (secret values out of agent process memory).
- Phase 3: hosted/BYOC brokered control plane (stronger isolation + policy + audit), suitable for paid offering.
