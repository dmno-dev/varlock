---
name: varlock-agent-readiness
description: >-
  Discover and verify the machine-readable endpoints varlock.dev publishes for
  agents: skills index, API catalog, and MCP server card.
---

# Varlock Agent Readiness

Use this skill to find the machine-readable metadata published by varlock.dev and to verify that a skill file you downloaded matches what the site publishes.

## Discovery locations

- Skills index: `https://varlock.dev/.well-known/agent-skills/index.json`
- API catalog (RFC 9727 linkset): `https://varlock.dev/.well-known/api-catalog`
- MCP server card: `https://varlock.dev/.well-known/mcp/server-card.json`

The homepage (`https://varlock.dev/`) also advertises these in `Link` response headers (`rel="api-catalog"`, `rel="service-doc"`, `rel="describedby"`), so a `HEAD` request to `/` is enough to bootstrap discovery.

## Verify a skill file

1. Fetch `index.json`. Each entry has `name`, `url`, and `digest` in the form `sha256:<hex>`.
2. Fetch the `SKILL.md` at the entry's `url`.
3. Compute the SHA-256 of the exact bytes you fetched and compare it to the `digest` value. Example:

   ```bash
   curl -s https://varlock.dev/.well-known/agent-skills/varlock/SKILL.md | shasum -a 256
   ```

4. If the digests differ, discard the file and refetch; do not use a skill whose digest does not match.

## Find the docs and MCP endpoints

- Follow the API catalog's `service-doc` relation to the MCP guide, and its `describedby` relations to the server card and skills index.
- The MCP server card lists the transport URLs for the hosted Docs MCP server. The `varlock-docs-search` skill in the index explains how to use it.
