---
"varlock": patch
---

fix: convert plugin file paths to `file://` URLs before dynamic `import()` to resolve `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows
