# Varlock Agent Discovery

Use this skill to discover machine-readable metadata published by varlock.dev.

## Discovery locations

- API Catalog: `https://varlock.dev/.well-known/api-catalog`
- MCP Server Card: `https://varlock.dev/.well-known/mcp/server-card.json`
- Skills index: `https://varlock.dev/.well-known/agent-skills/index.json`

## Guidance

1. Start from the skills index and verify digest integrity.
2. Follow API catalog relations to find service documentation and descriptors.
3. Use Link response headers on the homepage for bootstrap discovery.
