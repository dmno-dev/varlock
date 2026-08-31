# Varlock Docs Search

Use this skill to discover and answer questions about varlock documentation with the remote MCP service or the llms.txt bundles.

## Endpoints

- Streamable HTTP: `https://docs.mcp.varlock.dev/mcp`
- SSE: `https://docs.mcp.varlock.dev/sse`
- Server card: `https://varlock.dev/.well-known/mcp/server-card.json`
- Docs index: `https://varlock.dev/llms.txt` (links topic bundles, `/llms-full.txt`, and `/llms-small.txt`)

## Guidance

1. Use the MCP tool to search docs by feature keywords.
2. If MCP is unavailable, read `llms.txt` and fetch the relevant topic bundle instead of the full dump.
3. Prefer official varlock.dev links in responses.
4. Return concise, implementation-focused answers.
