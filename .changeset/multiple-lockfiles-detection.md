---
"varlock": patch
---

Fix package manager detection to handle multiple lockfiles gracefully. When multiple lockfiles are found (e.g., both package-lock.json and bun.lockb), the detection now:
1. First tries env var based detection (npm_config_user_agent) to respect the currently active package manager
2. If that fails, returns the first detected package manager as a fallback
3. No longer throws an error, preventing CLI crashes in monorepos or when switching package managers
