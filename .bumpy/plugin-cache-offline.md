---
varlock: patch
---

Cached pinned `@plugin` packages now load without a registry lookup, so offline loads work after the plugin is cached (e.g. via `varlock install-plugin`). Registry errors now name the plugin and URL.
