---
"@varlock/vite-integration": patch
---

Fix ENV.* static replacement being skipped for Vite dev module IDs with query suffixes (e.g. `?tsr-split=component` from TanStack Router split routes). The file extension is now extracted from the path portion of the ID only, ignoring any query string or hash fragment.
