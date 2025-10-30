# Varlock Docs MCP

This is a MCP server that allows you to search the Varlock docs.

## Usage

```bash
pnpm run dev
```

Then you can use the MCP server in your MCP client.

For example, you can use the MCP server in Cursor by adding the following to your `.cursor/mcp.json` file:

```json
{
  "mcpServers": {
    "varlock-docs-mcp-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8787/sse"]
    }
  }
}
```

or via the local MCP server inspector:

```bash
pnpm run inspector
```

## Cloudflare

The server is deployed automaticaly to cloudlfare workers when you open a PR or merge to `main`.

It relies on an AI Gateway and an AI Search (autoRAG) to search the Varlock docs.

