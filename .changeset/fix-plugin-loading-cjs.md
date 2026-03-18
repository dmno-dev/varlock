---
"varlock": minor
"@varlock/aws-secrets-plugin": patch
"@varlock/azure-key-vault-plugin": patch
"@varlock/bitwarden-plugin": patch
"@varlock/google-secret-manager-plugin": patch
"@varlock/infisical-plugin": patch
"@varlock/pass-plugin": patch
"@varlock/1password-plugin": patch
---

fix: switch plugins to CJS output to fix `SyntaxError: Unexpected identifier 'as'` when loading plugins via the standalone binary

Previously plugins were built as ESM and the SEA loader fixed a few issues before loading. Plugins now build as CJS directly, and the SEA loader executes them in a standard `node:vm` CJS context with no transformation needed.
