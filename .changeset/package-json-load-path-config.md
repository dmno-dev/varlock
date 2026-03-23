---
"varlock": patch
"@varlock/vite-integration": patch
---

Add support for configuring the default env file load path via `package.json`.

You can now set a `varlock.loadPath` key in your `package.json` to configure the default path used when loading `.env` files:

```json title="package.json"
{
  "varlock": {
    "loadPath": "./envs/"
  }
}
```

This is useful when you store your `.env` files in a custom directory (e.g., when using Vite's `envDir` option). The CLI `--path` flag continues to override this setting when provided.

The Vite integration will also now show a warning if `envDir` is set in your Vite config, with instructions to use `varlock.loadPath` in `package.json` instead.
