---
varlock: patch
---

Runtime leak detection now catches secrets in compressed responses: gzipped responses that fit in a single chunk (i.e. most pages) were never scanned, so browsers — which always send `Accept-Encoding: gzip` — could receive leaked sensitive values the scanner should have blocked. Brotli and zstd responses are now scanned too, and compressed chunks containing a leak fail closed (the response is killed) instead of passing through.

Note: since most browser traffic previously bypassed the scanner, an app with an existing undetected leak will start seeing those responses blocked after upgrading — look for `DETECTED LEAKED SENSITIVE CONFIG` in server logs, which names the offending config key.
