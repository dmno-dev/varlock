---
varlock: minor
---

Bundle the icons used by built-in data types, so `@generateTsTypes` no longer fetches them over the network. Plugins can ship their own icons via `plugin.bundledIcons`. Also adds an `icons=false` option to leave icons out of generated types entirely.
