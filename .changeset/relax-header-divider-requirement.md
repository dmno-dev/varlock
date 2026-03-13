---
"@env-spec/parser": minor
"varlock": minor
---

Relax header divider requirement - the header block no longer requires a trailing `# ---` divider. All comment blocks before the first config item are now treated as part of the header. Add validation errors for misplaced decorators: item decorators in the header, root decorators on config items, and decorators in detached comment blocks.
