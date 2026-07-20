---
"@varlock/cloudflare-integration": patch
---

Stop embedding `.dev.vars` contents in the preview FIFO helper's process argv. Secrets are passed on stdin with a control fd, matching `varlock-wrangler`.
