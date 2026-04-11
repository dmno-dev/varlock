---
"@varlock/1password-plugin": patch
---

Fix duplicate 1Password references silently failing when using SDK (service account token) - batch entries were being overwritten instead of deduplicated, and improve error handling in batch resolution
