# @varlock/ts-content-mapper (prototype)

A [TypeScript 7.1 content mapper](https://github.com/microsoft/typescript-go) that types varlock's `ENV` straight from `.env.schema`. App code keeps `import { ENV } from 'varlock/env'`, and there is no generated `env.d.ts`: while `tsc` runs, the mapper turns the schema into virtual TypeScript that augments `varlock/env`.

This is a prototype. It is private, unpublished, and its API, options and package name can change.

## Try it

From a fresh clone of this branch:

```sh
bun install
bunx turbo run check --filter=@varlock/ts-content-mapper-example
```

The second command builds `varlock` and the mapper, then runs `tsc -p . --runExternalCode` in [`example/`](./example). It passes with no output. To see it catch a mistake, add a wrong-typed use to `example/src/index.ts` (for example `const port: string = ENV.PORT;`) and run it again from the example directory:

```sh
cd packages/ts-content-mapper/example
bun run check
# src/index.ts(..): error TS2322: Type 'number' is not assignable to type 'string'.
```

Schema mistakes show up the same way, located in `.env.schema` (for example `# @type=porrt` gives `TS2551 ... Did you mean 'port'?`).

## How it is wired

The example's [`tsconfig.json`](./example/tsconfig.json):

```jsonc
{
  "contentMappers": [
    { "package": "@varlock/ts-content-mapper", "extensions": [".schema"], "options": { "exposeEnv": "global" } }
  ],
  "include": ["src", ".env.schema"]
}
```

- `.env.schema` is in `include`, so TypeScript asks the mapper to transform it. TypeScript finds the mapper process through the `typescript.contentMapper` field of this package's `package.json` (`node dist/server.mjs`).
- The mapper's main output is varlock's own `@generateTsTypes` output for the schema (the same types `env.d.ts` codegen would write), with each key mapped back to its line in the schema, so hover, go to definition, find references and rename work across the schema and app code in an editor that runs TS 7.1.
- A second virtual file lowers the schema itself into checked TypeScript against an API generated from varlock's registries (data types, resolvers, decorators, including those added by plugins). Schema mistakes become ordinary TS errors at their location in `.env.schema`, and they do not hide errors in app code.
- The schema is loaded with varlock's shape mode (`new EnvGraph({ mode: 'shape' })`): `exec()` and other non-pure resolvers are not run, root decorators are not executed, plugins are never downloaded, and `process.env` is ignored. Installed plugins are still imported, so their module code runs.
- Values of `@sensitive` items are not copied into the virtual TypeScript.
- Debugging: `VARLOCK_MAPPER_LOG=<file>` appends one line per transform (`tsc` does not show mapper stderr), and `VARLOCK_MAPPER_DUMP=<dir>` writes the virtual files.

## Versions

- `typescript@7.1.0-dev.20261009.1` in the example. Content mappers only exist in TS 7.1 (7.0.2 has no `--runExternalCode`). `7.1.0-beta` was published on 2026-10-20, which is too new to pin here (we prefer versions at least two weeks old). This nightly is from 2026-10-09, and the example passes on both.
- `ts-content-mapper@0.1.0`, the content mapper SDK this package is built on.
- Node `^22.18.0 || >=24.11.0` (from `ts-content-mapper`).

## Limits

- **CLI flag only.** Content mappers need `tsc --runExternalCode`, and TypeScript only accepts that flag on the command line (TS6266), not in `tsconfig.json`. Every script or CI job that type-checks needs it. Without it, `tsc` reports `TS18068` and `ENV` has none of the schema keys.
- **Next.js** runs its own type check with fixed arguments, so it cannot pass the flag. You need `typescript.ignoreBuildErrors: true` in `next.config` plus a separate `tsc --noEmit --runExternalCode` step (after `next typegen`) before `next build`. A plain `next build` then skips type errors silently.
- **Types only.** The runtime is unchanged: values still come from varlock (`varlock run`, `varlock/auto-load` or a framework integration).
- **TS 7.1 adoption.** Editors need the TS 7.1 language server (`js/ts.experimental.useTsgo` in VS Code, pointed at the workspace's `typescript`). typescript-eslint does not support TS 7 yet.
- **Known gaps** (from the spike's real-world run): a few data type options the mapper does not know are reported as errors (`string(allowEmpty)` and similar), and errors inside `@import`ed schema files are not shown.

## Tests

```sh
bunx turbo run build --filter=@varlock/ts-content-mapper
cd packages/ts-content-mapper && bun run test:ci
```

Each test runs the real `tsc --runExternalCode` against the built mapper: the example type-checks and its type assertions hold (and fail when the schema changes), wrong-typed app code is a TS error, schema errors are TS errors located in `.env.schema`, `exec()` in a schema is never run, no network request is made (a pinned plugin that is not installed is refused, not downloaded), and sensitive values stay out of the virtual code.
