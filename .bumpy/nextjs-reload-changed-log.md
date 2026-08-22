---
"@varlock/nextjs-integration": patch
---

The env reload log now reports "no changes found" correctly. It previously always said "changes found", because the comparison also picked up formatting and internal bookkeeping that shift on every reload
