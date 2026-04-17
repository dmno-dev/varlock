---
"varlock": patch
---

Fix leak detection for Uint8Array/ArrayBuffer response bodies

`scanForLeaks` now detects secrets in `Uint8Array`, `ArrayBufferView`, and `ArrayBuffer` values. Previously these fell through unscanned, so secrets returned as binary-encoded response bodies (common in Cloudflare Workers) were not caught.
