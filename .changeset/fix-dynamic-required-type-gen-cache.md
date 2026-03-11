---
"varlock": patch
---

Fix dynamic `@required` being incorrectly resolved after type generation runs.

When `generateTypesIfNeeded()` ran before `resolveEnvValues()` (as it does in the CLI), `getTypeGenInfo()` would call `resolve()` on dynamic decorators like `@required=eq($OTHER, foo)` before their dependencies were resolved. This cached a stale result on the decorator, causing `processRequired()` to return the wrong value when env values were later resolved.

The fix skips calling `resolve()` for dynamic decorators in `getTypeGenInfo()` — their runtime value is irrelevant for type generation anyway (dynamic required items are always typed as optional).
