# Varlock Agent Discovery

Use this skill to discover machine-readable metadata published by varlock.dev.

## Discovery locations

- Docs index for agents: `https://varlock.dev/llms.txt` (topic bundles are linked from it under `/_llms-txt/`; full and abridged dumps at `/llms-full.txt` and `/llms-small.txt`)
- AI catalog (ARD manifest): `https://varlock.dev/.well-known/ai-catalog.json`
- API Catalog (RFC 9727 linkset): `https://varlock.dev/.well-known/api-catalog`
- MCP Server Card: `https://varlock.dev/.well-known/mcp/server-card.json` (aliases: `/.well-known/mcp.json`, `/.well-known/mcp/server-cards.json`)
- Skills index: `https://varlock.dev/.well-known/agent-skills/index.json`
- Sitemap: `https://varlock.dev/sitemap-index.xml`

## Guidance

1. Start from `llms.txt` for a summary of what varlock is and when to use it, then follow the topic bundle you need.
2. Start from the skills index and verify digest integrity before loading a SKILL.md.
3. Follow API catalog relations to find service documentation and descriptors.
4. Use Link response headers on the homepage for bootstrap discovery.
5. Any docs page returns markdown when requested with `Accept: text/markdown`. Missing paths return a 404 with a short markdown body listing recovery links.
