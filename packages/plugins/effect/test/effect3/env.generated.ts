/**
 * Generated from .env.schema by Varlock for Effect 3. Do not edit by hand.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

export const config = Config.all({
  "NAME": Config.string("NAME"),
  "ENABLED": Config.boolean("ENABLED"),
  "PORT": Config.integer("PORT"),
  "RATIO": Config.number("RATIO"),
  "STAGE": Config.literal("dev", "prod")("STAGE"),
  "LEVEL": Config.literal(1, 2)("LEVEL"),
  "HOSTS": Config.mapAttempt(Config.string("HOSTS"), (value) => JSON.parse(value) as Array<string>),
  "MATRIX": Config.mapAttempt(Config.string("MATRIX"), (value) => JSON.parse(value) as Array<Array<number>>),
  "LIMITS": Config.mapAttempt(Config.string("LIMITS"), (value) => JSON.parse(value) as Partial<Record<"us" | "eu", number>>),
  "FLAGS": Config.mapAttempt(Config.string("FLAGS"), (value) => JSON.parse(value) as Record<string, boolean>),
  "ENTRIES": Config.mapAttempt(Config.string("ENTRIES"), (value) => JSON.parse(value) as Array<Record<string, Array<number>>>),
  "DATA": Config.mapAttempt(Config.string("DATA"), (value) => JSON.parse(value) as Record<string, unknown>),
  "METADATA": Config.mapAttempt(Config.string("METADATA"), (value) => JSON.parse(value) as Record<string, unknown>),
  "OPTIONAL": Config.option(Config.string("OPTIONAL")),
  "OPTIONAL_PORT": Config.option(Config.integer("OPTIONAL_PORT")),
  "OPTIONAL_DATA": Config.option(Config.mapAttempt(Config.string("OPTIONAL_DATA"), (value) => JSON.parse(value) as Record<string, unknown>)),
  "TOKEN": Config.option(Config.redacted(Config.string("TOKEN"))),
  "SECRET_PORT": Config.redacted(Config.integer("SECRET_PORT")),
  "SECRET_STAGE": Config.redacted(Config.literal("dev", "prod")("SECRET_STAGE")),
  "SECRET_DATA": Config.redacted(Config.mapAttempt(Config.string("SECRET_DATA"), (value) => JSON.parse(value) as Record<string, unknown>)),
  "SECRET_HOSTS": Config.option(Config.redacted(Config.mapAttempt(Config.string("SECRET_HOSTS"), (value) => JSON.parse(value) as Array<string>))),
})

/** Loads environment values when executed, converting config failures to defects. */
export const generated = config.pipe(Effect.orDie)
