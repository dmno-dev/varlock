---
'@varlock/cloudflare-integration': patch
---

cloudflare: skip wrangler restart when env file is saved with unchanged contents (drops the 5s idle threshold that re-triggered restarts on every save after a short pause)
