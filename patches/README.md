# Dependency patches

Patches applied by bun at install time, registered under `patchedDependencies` in the root `package.json`.

Patches do **not** travel to end users through npm. They only work here because the affected dependency is
bundled into a package's `dist/` at build time, so the patched code is what actually gets published.

## `kdbxweb@2.1.1`

Used by `@varlock/keepass-plugin`, which bundles it (and its `@xmldom/xmldom` dependency) into
`dist/plugin.cjs`.

kdbxweb declares `@xmldom/xmldom@^0.7.4` and passes the old `errorHandler` object to `new DOMParser()`.
The root `overrides` entry pins `@xmldom/xmldom` to `>=0.9.10` for security reasons, and xmldom 0.9 removed
the `errorHandler` object in favor of `onError`, so every attempt to open a database failed with:

```
errorHandler object is no longer supported, switch to onError!
```

kdbxweb is unmaintained (last release 2021) and upstream still has the old code, so there is no version to
upgrade to. The patch swaps the `errorHandler` object for an equivalent `onError` callback that throws on
any level, matching the previous behavior.

Removing this patch requires dropping the `@xmldom/xmldom` override back to 0.7.x, which reintroduces known
vulnerabilities. The keepass plugin test suite covers this: it runs against the built bundle, so it fails if
the patch stops applying.
