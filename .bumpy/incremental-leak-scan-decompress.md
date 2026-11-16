---
varlock: patch
---

Speed up the response leak scan on large compressed (gzip/br/zstd) responses by decompressing each chunk once instead of re-decompressing the whole response on every write
