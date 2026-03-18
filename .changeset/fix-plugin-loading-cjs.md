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

fix: switch plugins to CJS output to fix plugin loading errors in the standalone binary

Previously plugins were built as ESM and the loader performed a fragile regex-based ESM→CJS transformation. Plugins now build as CJS directly and are loaded via `new Function` in the main runtime context, which avoids both the ESM parse errors and Node.js internal assertion failures (e.g. `DOMException` lazy getter crashing in vm sandbox contexts).
