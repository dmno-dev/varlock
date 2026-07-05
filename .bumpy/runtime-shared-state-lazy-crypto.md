---
varlock: patch
---

Runtime fixes: env state is now shared across bundled copies of `varlock/env` (fixes stale values after env reloads when a bundler duplicates the module); runtime leak detection now catches secrets in gzipped responses — previously compressed responses that fit in a single chunk (i.e. most pages, and browsers always send `Accept-Encoding: gzip`) were never scanned — and fails closed when a compressed chunk can't be scrubbed; `node:crypto` is loaded lazily and encrypted env blobs decrypt via WebCrypto on edge runtimes without it (e.g. Vercel Edge)
