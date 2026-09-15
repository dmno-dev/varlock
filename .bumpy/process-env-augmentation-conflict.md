---
varlock: patch
---

Skip the process.env type augmentation when another .d.ts (e.g. wrangler's worker-configuration.d.ts) already declares NodeJS.ProcessEnv, which previously caused a TS2320 conflict. Set processEnv=strict on @generateTsTypes to override.
