---
varlock: minor
---

New `varlock flatten` command: collapses the @import graph into a self-contained directory (rewriting import paths, pinning plugin versions) so a single package can be deployed without the rest of the monorepo, e.g. in Docker builds
