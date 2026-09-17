# @varlock/effect-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/effect-plugin.svg)](https://npmx.dev/package/@varlock/effect-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/effect-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that generates an [Effect](https://effect.website/) `Config` module from your environment schema. Both Effect 3 and Effect 4 are supported.

Originally written by [dan-myles](https://github.com/dan-myles) as [varlock-effect-plugin](https://github.com/dan-myles/varlock-effect-plugin) and contributed to the Varlock monorepo.

## Install

Install the plugin in the workspace that owns `.env.schema`. The generated module imports
Effect modules, so that workspace must also depend on Effect.

```sh
bun add -d @varlock/effect-plugin
bun add effect
```

Supported Effect versions:

| Effect | Requirement |
| --- | --- |
| 3 | any `3.x` release |
| 4 | `4.0.0-rc.113` or later (earlier betas and release candidates used a different `Config` API) |

The plugin generates different code for each major. It reads the installed `effect` version
from the directory that will contain the generated file and picks the matching target, so
upgrading Effect from 3 to 4 only requires regenerating the module.

## Configure

```dotenv
# @plugin(@varlock/effect-plugin)
# @generateEffectConfig(path=./src/env.generated.ts)
# ---
# @type=enum(development, staging, production) @public
APP_ENV=development

# @type=port @public
PORT=3000

# @type=array(string, format=json) @public
HOSTS='["localhost","example.com"]'

# @sensitive
API_TOKEN=
```

Generate the module explicitly:

```sh
bunx varlock codegen
```

Varlock also regenerates it during `varlock load` and `varlock run` unless the decorator uses
`auto=false`.

### Options

| Option | Description |
| --- | --- |
| `path` | Output file, relative to the schema. Required. |
| `effectVersion` | `3` or `4`. Optional. When set, it is used as-is. Otherwise the plugin reads the `effect` package installed next to the output file, and fails if it cannot find one (for example, a monorepo root schema whose apps install Effect themselves). |
| `auto`, `filter`, `executeWhenImported` | Shared code generation options. See the [code generation guide](https://varlock.dev/guides/code-generation/). |

```dotenv
# @generateEffectConfig(path=./src/env.generated.ts, effectVersion=4)
```

## Use

```ts
import { Effect } from "effect"

import { generated } from "./env.generated.js"

const program = Effect.gen(function* () {
  const env = yield* generated

  console.log(env.APP_ENV)
})

Effect.runPromise(program)
```

`generated` is an Effect that loads environment values when executed. Missing required values
and decoding failures become defects, so consumers do not need to add `Effect.orDie`. Missing
optional values remain `Option.none()`. Each execution reads the config again; yield it during
startup to fail before starting your application.

The `config` export exposes the underlying Effect `Config` with typed config error failures
for custom error handling, Config composition, or explicit providers. The provider API differs
by version:

```ts
// Effect 4
Effect.runPromise(config.parse(ConfigProvider.fromEnv()))

// Effect 3
Effect.runPromise(config.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())))
```

Applications that want dependency injection can define their own service and layer:

```ts
import { Config, Context, Layer } from "effect"

import { config, generated } from "./env.generated.js"

export class Env extends Context.Service<Env, Config.Success<typeof config>>()("my-app/Env") {
  static readonly layer = Layer.effect(Env, generated)
}
```

Provide `Env.layer` at the application boundary and use `const env = yield* Env` in consumers.
Use `Layer.effect(Env, config)` instead to retain typed failures during layer construction.
On Effect 3, use `Config.Config.Success` and `Context.Tag` in place of `Config.Success` and
`Context.Service`.

Run the application through Varlock so it validates and injects the environment first:

```sh
bunx varlock run -- bun run src/index.ts
```

## Generated code

The generator maps Varlock values to Effect as follows:

| Varlock schema | Effect 4 | Effect 3 |
| --- | --- | --- |
| string-like values | `Config.String` | `Config.string` |
| boolean | `Config.Boolean` | `Config.boolean` |
| int | `Config.schema` with `Schema.Number` checked by `Number.isInteger` | `Config.integer` |
| number | `Config.Number` | `Config.number` |
| enum | `Config.Literals([members], key)` | `Config.literal(members)(key)` |
| array, record, object | `Config.schema(Schema.fromJsonString(Schema.Unknown), key)`, mapped to the generated type | `Config.mapAttempt(Config.string(key), JSON.parse)`, cast to the generated type |
| `@sensitive` | `Config.map(config, Redacted.make)` with a generated `redactErrors` helper | `Config.redacted` |
| optional | `Config.option` | `Config.option` |

Scalar enums must have at least one member and distinct environment string representations.
For example, `enum(1, "1")` and `enum(true, "true")` fail generation because environment strings
cannot preserve which member Varlock resolved. Repeated identical members are allowed.
Enums inside JSON composites retain their value types. Empty nested enums emit `never`, so empty
collections remain representable. Record enum keys use string property names, including numeric
and boolean members.

Composite values are parsed from Varlock's serialized JSON wire format. Varlock remains responsible
for schema validation before it injects those values.

Arrays with scalar elements require `format=json`, as in `@type=array(string, format=json)`.
Varlock's default scalar-array format is separator-delimited. Arrays containing composite values
and records already serialize as JSON.

Integer configs accept the same values as `Number.isInteger`, including integers outside the safe
integer range. Fractional values, `NaN`, and infinities fail.

Sensitive values are wrapped after parsing. Optional sensitive values have type
`Option<Redacted<T>>`. Sensitive failures retain the field name but replace their details with
`<redacted>`, including enum literals and provider error causes. Missing optional secrets still
become `Option.none()`.

The `config` export reports loading and decoding failures as a typed config error
(`Config.ConfigError` on Effect 4, `ConfigError.ConfigError` on Effect 3). The `generated` export
converts those failures to defects after sanitizing sensitive errors. Invalid supplied values
still fail even when the field is optional.

### Empty strings

Effect 4's default environment provider treats empty strings as missing. A required empty value
fails, and an optional empty value becomes `Option.none()`. Effect 3 preserves empty strings: a
required empty string succeeds with `""` and an optional one becomes `Option.some("")`.

Effect 4 applications that need to preserve empty strings can supply a provider explicitly:

```ts
import { ConfigProvider, Effect } from "effect"

import { config } from "./env.generated.js"

Effect.runPromise(
  config.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })).pipe(Effect.orDie),
)
```

## Migrate from varlock-effect-plugin

Replace the community package with the scoped package in the workspace that owns your schema:

```sh
bun remove varlock-effect-plugin
bun add -d @varlock/effect-plugin
```

Change `@plugin(varlock-effect-plugin)` to `@plugin(@varlock/effect-plugin)` in `.env.schema`,
then run `bunx varlock codegen`. The `@generateEffectConfig` decorator and generated exports
are unchanged from `varlock-effect-plugin@0.3.0`.

`varlock-effect-plugin@0.3.0` was pinned to `effect@4.0.0-rc.112`. That release candidate is not
supported here because Effect renamed the `Config` constructors in `rc.113`. Upgrade Effect to
`4.0.0-rc.113` or later and regenerate.

If you are migrating from `varlock-effect-plugin@0.1.0` (Effect 3), the scoped plugin keeps
generating Effect 3 code until you upgrade Effect, so nothing changes beyond the plugin name and
the export changes below.

## Migrate existing generated modules

Regenerate with `bunx varlock codegen`. The `generated` export is now an Effect with no typed
failures. Existing `yield* generated` calls keep working, and `.pipe(Effect.orDie)` is redundant.
Use the new `config` export wherever you previously used `generated` as a `Config`, Config
combinators, `Config.Success<typeof generated>`, or typed config error handling. Use
`Effect.Success<typeof generated>` to infer the loaded values from `generated`.

## Migrate from Effect 3 to Effect 4

Upgrade `effect` to `4.0.0-rc.113` or later, then regenerate:

```sh
bunx varlock codegen
```

The plugin detects the new major and emits Effect 4 code. The `@generateEffectConfig` decorator
and `yield* generated` syntax stay the same. Regenerate existing modules before running them with
Effect 4, and review the empty string behavior described above.

## Local development

From the monorepo root:

```sh
bun install
bunx turbo run build --filter=@varlock/effect-plugin
bun run --filter @varlock/effect-plugin test:ci
bun run --filter @varlock/effect-plugin typecheck
```

Tests run twice, once against `effect@4` and once against the `effect3` alias (`npm:effect@3`),
so both generated targets are exercised at runtime and typechecked.
