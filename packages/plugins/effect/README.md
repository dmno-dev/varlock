# @varlock/effect-plugin

Generate an [Effect 4 Config](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.112/packages/effect/src/Config.ts) module from a
[Varlock](https://varlock.dev/) environment schema.

## Install

Install the plugin in the workspace that owns `.env.schema`. The generated module imports
Effect modules, so that workspace must also depend on Effect.

This release requires exactly `effect@4.0.0-rc.112`. Both the peer dependency and development
dependency are pinned because Effect prereleases can change APIs.

```sh
bun add -d @varlock/effect-plugin
bun add --exact effect@4.0.0-rc.112
```

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

The `config` export exposes the underlying Effect Config with typed `Config.ConfigError` failures
for custom error handling, Config composition, or explicit providers via `config.parse(provider)`.

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

Run the application through Varlock so it validates and injects the environment first:

```sh
bunx varlock run -- bun run src/index.ts
```

The generator maps Varlock values to Effect as follows:

| Varlock schema | Generated Effect Config |
| --- | --- |
| string-like values | `Config.string` |
| boolean | `Config.boolean` |
| int | `Config.schema` with `Schema.Number` checked by `Number.isInteger` |
| number | `Config.number` |
| enum | `Config.literals([members], key)` |
| array, record, object | `Config.schema(Schema.fromJsonString(Schema.Unknown), key)`, mapped to the generated type |
| `@sensitive` | `Config.map(config, Redacted.make)` with sanitized errors |
| optional | `Config.option` |

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
integer range, matching Effect 3 and Varlock. Fractional values, `NaN`, and infinities fail.

Sensitive values are wrapped after parsing. Optional sensitive values have type
`Option<Redacted<T>>`. Sensitive failures retain the field name but replace their details with
`<redacted>`, including enum literals and provider error causes. Missing optional secrets still
become `Option.none()`.

The `config` export reports loading and decoding failures as `Config.ConfigError` from
`effect/Config`. The `generated` export converts those failures to defects after sanitizing
sensitive errors. Invalid supplied values still fail even when the field is optional.

## Migrate from varlock-effect-plugin

Replace the community package with the scoped package in the workspace that owns your schema:

```sh
bun remove varlock-effect-plugin
bun add -d @varlock/effect-plugin
bun add --exact effect@4.0.0-rc.112
```

Change `@plugin(varlock-effect-plugin)` to `@plugin(@varlock/effect-plugin)` in `.env.schema`,
then run `bunx varlock codegen`. The `@generateEffectConfig` decorator and generated exports
are unchanged from `varlock-effect-plugin@0.3.0`.

If you are migrating from an earlier version, also follow the export and Effect 3 migration
instructions below.

## Migrate existing generated modules

Regenerate with `bunx varlock codegen`. The `generated` export is now an Effect with no typed
failures. Existing `yield* generated` calls keep working, and `.pipe(Effect.orDie)` is redundant.
Use the new `config` export wherever you previously used `generated.parse(...)`, Config
combinators, `Config.Success<typeof generated>`, or typed config error handling. Use
`Effect.Success<typeof generated>` to infer the loaded values from `generated`.

## Migrate from Effect 3

This is a breaking change. Projects using Effect 3 should remain on `varlock-effect-plugin@0.1.0`.
To migrate, update the plugin, install the pinned Effect 4 release shown above, then regenerate:

```sh
bunx varlock codegen
```

The `@generateEffectConfig` decorator and `yield* generated` syntax stay the same. The export and
error-handling changes described above also apply. Regenerate existing modules before running
them with Effect 4.

Effect 4's default environment provider treats empty strings as missing. A required empty value
fails, and an optional empty value becomes `Option.none()`. Applications that need to preserve empty
strings can supply a provider explicitly:

```ts
import { ConfigProvider, Effect } from "effect"

import { config } from "./env.generated.js"

Effect.runPromise(
  config.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })).pipe(Effect.orDie),
)
```

## Local development

From the monorepo root:

```sh
bun install
bunx turbo run build --filter=@varlock/effect-plugin
bun run --filter @varlock/effect-plugin test:ci
bun run --filter @varlock/effect-plugin typecheck
```

## License

MIT. Originally contributed by [dan-myles](https://github.com/dan-myles/varlock-effect-plugin).
