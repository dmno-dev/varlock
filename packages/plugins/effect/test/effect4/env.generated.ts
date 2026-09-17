/**
 * Generated from .env.schema by Varlock for Effect 4. Do not edit by hand.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"

function redactErrors<A>(config: Config.Config<A>, key: string): Config.Config<A> {
  return Config.orElse(config, () => {
    const error = new Schema.SchemaError(
      new SchemaIssue.Pointer([key], new SchemaIssue.InvalidValue({ message: "<redacted>" })),
    )
    // Config.fail is typed as Config<unknown> in this Effect release, but never succeeds.
    return Config.fail(error) as Config.Config<never>
  })
}


export const config = Config.all({
  "NAME": Config.String("NAME"),
  "ENABLED": Config.Boolean("ENABLED"),
  "PORT": Config.schema(Schema.Number.check(Schema.makeFilter(Number.isInteger, { expected: "an integer" })), "PORT"),
  "RATIO": Config.Number("RATIO"),
  "STAGE": Config.Literals(["dev", "prod"], "STAGE"),
  "LEVEL": Config.Literals([1, 2], "LEVEL"),
  "HOSTS": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "HOSTS"), (value) => value as Array<string>),
  "MATRIX": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "MATRIX"), (value) => value as Array<Array<number>>),
  "LIMITS": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "LIMITS"), (value) => value as Partial<Record<"us" | "eu", number>>),
  "FLAGS": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "FLAGS"), (value) => value as Record<string, boolean>),
  "ENTRIES": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "ENTRIES"), (value) => value as Array<Record<string, Array<number>>>),
  "DATA": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "DATA"), (value) => value as Record<string, unknown>),
  "METADATA": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "METADATA"), (value) => value as Record<string, unknown>),
  "OPTIONAL": Config.option(Config.String("OPTIONAL")),
  "OPTIONAL_PORT": Config.option(Config.schema(Schema.Number.check(Schema.makeFilter(Number.isInteger, { expected: "an integer" })), "OPTIONAL_PORT")),
  "OPTIONAL_DATA": Config.option(Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "OPTIONAL_DATA"), (value) => value as Record<string, unknown>)),
  "TOKEN": redactErrors(Config.option(Config.map(Config.String("TOKEN"), Redacted.make)), "TOKEN"),
  "SECRET_PORT": redactErrors(Config.map(Config.schema(Schema.Number.check(Schema.makeFilter(Number.isInteger, { expected: "an integer" })), "SECRET_PORT"), Redacted.make), "SECRET_PORT"),
  "SECRET_STAGE": redactErrors(Config.map(Config.Literals(["dev", "prod"], "SECRET_STAGE"), Redacted.make), "SECRET_STAGE"),
  "SECRET_DATA": redactErrors(Config.map(Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "SECRET_DATA"), (value) => value as Record<string, unknown>), Redacted.make), "SECRET_DATA"),
  "SECRET_HOSTS": redactErrors(Config.option(Config.map(Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "SECRET_HOSTS"), (value) => value as Array<string>), Redacted.make)), "SECRET_HOSTS"),
})

/** Loads environment values when executed, converting config failures to defects. */
export const generated = config.pipe(Effect.orDie)
