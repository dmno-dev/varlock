---
varlock: minor
---

Bundle the icons used by built-in data types, so `@generateTsTypes` no longer fetches them over the network. Plugins can ship their own icons via `plugin.bundledIcons`, and plugin data types and resolvers without an icon now use the plugin's icon. Also adds an `icons=false` option to leave icons out of generated types entirely.
