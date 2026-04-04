---
"varlock": patch
---

Fix "Instance with id '_default' already initialized" error when the same schema directory is imported via multiple paths (diamond dependency pattern). Previously, if schema A imported schema C and schema B imported schema A and C, loading schema A would cause C's plugin init decorators to run twice. The fix deduplicates imports by path, so each directory or file is only loaded once per graph.
