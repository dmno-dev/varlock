---
"varlock": minor
"@varlock/1password-plugin": patch
"@varlock/aws-secrets-plugin": patch
"@varlock/azure-key-vault-plugin": patch
"@varlock/bitwarden-plugin": patch
"@varlock/google-secret-manager-plugin": patch
"@varlock/hashicorp-vault-plugin": patch
"@varlock/infisical-plugin": patch
"@varlock/pass-plugin": patch
"@varlock/proton-pass-plugin": patch
---

Add support for single-file ESM and TypeScript plugins, and improve the plugin authoring API.

**New: ESM and TypeScript single-file plugins**

Single-file plugins can now be written as `.mjs` or `.ts` files in addition to `.js`/`.cjs`. TypeScript plugins require Bun.

**Improved: explicit `plugin` import instead of injected global**

Plugin authors should now import `plugin` explicitly from `varlock/plugin-lib` rather than relying on the injected global:

```js
// CJS plugin (.js / .cjs)
const { plugin } = require('varlock/plugin-lib');

// ESM plugin (.mjs / .ts)
import { plugin } from 'varlock/plugin-lib';
```

This works in both regular installs and SEA binary builds. Error classes (`ValidationError`, `CoercionError`, etc.) are also now directly importable from `varlock/plugin-lib`.

**Breaking change:** the implicit `plugin` global is no longer injected into CJS plugin modules. Existing plugins must add `const { plugin } = require('varlock/plugin-lib')`.
