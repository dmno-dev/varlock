---
"varlock": patch
---

Support XDG Base Directory Specification for user config directory. Varlock now respects `$XDG_CONFIG_HOME` and defaults to `~/.config/varlock` instead of `~/.varlock` for new installations, while maintaining backwards compatibility with existing `~/.varlock` directories.
