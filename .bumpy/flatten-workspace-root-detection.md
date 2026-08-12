---
varlock: patch
---

varlock flatten now detects the workspace root in any language (uv, poetry, cargo, go.work, composer, bundler, gradle, .NET, bazel), falls back to the git root, and accepts --workspace-root to set it explicitly
