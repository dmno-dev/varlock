---
varlock: patch
---

The install script now verifies the sha256 of the downloaded archive against the release's published checksums.txt, and fails without installing on a mismatch.
