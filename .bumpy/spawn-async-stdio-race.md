---
varlock: patch
"@varlock/1password-plugin": patch
"@varlock/bitwarden-plugin": patch
"@varlock/keepass-plugin": patch
"@varlock/pass-plugin": patch
"@varlock/proton-pass-plugin": patch
---

Fix CLI calls occasionally losing stdout/stderr when the command exits quickly under load, which could surface as a vague "unknown" error instead of the real one
