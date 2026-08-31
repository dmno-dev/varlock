---
varlock: minor
---

Locally encrypted values now unlock once per session instead of re-prompting every five minutes. Approving an unlock covers every value it names until the session ends, and you choose what ends it: screen lock, sleep (the default), or only an explicit lock. The approval panel is drawn by the encryption daemon, so it can show you which process is actually asking and which keys it wants, before anything is decrypted.

New commands to see and manage that: `varlock sessions` lists what is currently unlocked, and `varlock lock` now takes `--current` to end just this terminal's session or `--session <id>` to end one you name. On macOS the menu bar shows the same sessions and can lock them individually.

Existing encrypted values keep working with no action required. To move them onto the new model, run `varlock encrypt --upgrade` (try `--dry-run` first to see what would change).
