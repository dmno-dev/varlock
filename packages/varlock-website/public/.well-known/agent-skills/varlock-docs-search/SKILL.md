---
name: varlock-docs-search
description: >-
  Find and read varlock documentation from varlock.dev: fetch any page as markdown,
  use the llms.txt indexes, or query the hosted Docs MCP server.
---

# Varlock Docs Search

Use this skill to answer questions about varlock from its documentation. Prefer the cheapest source that gives you the page text; fall back to the MCP server for keyword search when you do not know which page to read.

## Sources, cheapest first

1. **Any docs page as markdown.** Every page on `https://varlock.dev` serves markdown when you send `Accept: text/markdown`. The response includes frontmatter (`title`, `description`) and the page body. Example:

   ```bash
   curl -H "Accept: text/markdown" https://varlock.dev/guides/schema/
   ```

2. **Site indexes.**
   - `https://varlock.dev/llms.txt`: page list with one-line descriptions, for picking a page to fetch
   - `https://varlock.dev/llms-small.txt`: condensed docs in one file
   - `https://varlock.dev/llms-full.txt`: every docs page in one file

3. **Docs MCP server.** Use when you need keyword search across the docs.
   - Streamable HTTP: `https://docs.mcp.varlock.dev/mcp`
   - SSE: `https://docs.mcp.varlock.dev/sse`
   - It exposes one tool, named `varlock docs`, taking `{ query: string }`. It returns a generated summary with links, not verbatim page text. Fetch the linked page as markdown (source 1) before quoting details such as flags, decorator names, or defaults.

## Rules

- Link the `varlock.dev` page you took each answer from.
- Quote CLI flags, decorator names, function signatures, and defaults from the fetched page, not from memory or from the MCP summary.
- If the docs do not cover the question, say so instead of guessing.
