---
"@varlock/cloudflare-integration": patch
---

Fix intermittent 'secrets-file contents is not valid' error during wrangler deploy/versions upload in Linux CI. The FIFO that serves resolved env to wrangler re-armed a new writer in a tight loop, so a reader could read multiple concatenated copies of the JSON before seeing EOF. Writers now serve exactly one copy then exit, and a fresh single-shot writer is re-armed once that copy is consumed — only one writer is ever armed at a time (no concatenation), while still supporting wrangler reading the file more than once (e.g. `wrangler types` re-reads the env file). The FIFO is kept so resolved secrets never exist as a file at rest.
