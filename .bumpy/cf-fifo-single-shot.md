---
"@varlock/cloudflare-integration": patch
---

Fix intermittent 'secrets-file contents is not valid' error during wrangler deploy/versions upload in Linux CI. The FIFO that serves resolved env to wrangler re-armed a new writer in a tight loop, so a reader could read multiple concatenated copies of the JSON before seeing EOF. Writers now serve exactly one copy then exit (single-shot); the dev path re-arms a fresh writer after each read.
