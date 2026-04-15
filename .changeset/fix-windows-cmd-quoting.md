---
"varlock": patch
---

Fix `varlock run` on Windows: correctly build the cmd.exe command string when spawning `.cmd`/`.bat` files

Previously, individual arguments were double-quoted separately (e.g. `"tsx.cmd" "watch" "src/index.ts"`). Because cmd.exe's `/s /c` strips only the **first and last** quote from the entire command string, this left a stray `"` after the command name, causing errors like "The system cannot find the path specified."

The fix wraps the entire inner command string in a single pair of outer quotes (e.g. `"tsx.cmd watch src/index.ts"`), which is what cmd.exe expects. Paths or arguments that contain spaces are individually quoted inside those outer quotes.

Additionally, when `findCommand` cannot resolve a bare command name to a `.cmd`/`.bat` path, varlock now falls back to routing through cmd.exe so that Windows PATHEXT lookups (e.g. `tsx` → `tsx.cmd`, `pnpm` → `pnpm.cmd`) are handled automatically.
