---
"varlock": patch
"@varlock/nextjs-integration": patch
---

Fix diamond dependency handling when the same schema is imported via multiple paths. Previously, duplicate imports caused plugin init decorators to run twice ("Instance already initialized" error). Now, duplicate imports create lightweight `ImportAliasSource` nodes that appear at the correct precedence position without re-initializing the source. This correctly handles different importKeys subsets across import sites and preserves override semantics matching non-deduplicated behavior. Also adds `type` field to serialized source entries for easier filtering.
