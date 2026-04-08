---
"varlock": minor
---

Support multiple `loadPath` entries in `package.json` configuration.

The `varlock.loadPath` option in `package.json` now accepts an array of paths in addition to a single string. When an array is provided, all paths are loaded and their environment variables are combined. Later entries in the array take higher precedence when the same variable is defined in multiple locations.

```json title="package.json"
{
  "varlock": {
    "loadPath": ["./apps/my-package/envs/", "./apps/other-package/envs/"]
  }
}
```

This is particularly useful in monorepos where different packages each have their own `.env` files.
