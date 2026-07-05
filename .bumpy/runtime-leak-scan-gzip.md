---
varlock: patch
---

Runtime leak detection now catches secrets in compressed responses: gzipped responses that fit in a single chunk (i.e. most pages) were never scanned, so browsers — which always send `Accept-Encoding: gzip` — could receive leaked sensitive values the scanner should have blocked. Compressed chunks that can't be scrubbed now fail closed instead of passing through
