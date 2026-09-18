/**
 * Generated from .env.schema by Varlock for Effect 4. Do not edit by hand.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const config = Config.all({
  "EMPTY_ARRAY": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "EMPTY_ARRAY"), (value) => value as Array<never>),
  "EMPTY_VALUES": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "EMPTY_VALUES"), (value) => value as Record<string, never>),
  "EMPTY_KEYS": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "EMPTY_KEYS"), (value) => value as Partial<Record<never, number>>),
  "NESTED": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "NESTED"), (value) => value as Array<Record<string, Array<never>>>),
  "BOOLEAN_KEYS": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "BOOLEAN_KEYS"), (value) => value as Partial<Record<"true" | "false", number>>),
  "NUMERIC_KEYS": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "NUMERIC_KEYS"), (value) => value as Partial<Record<"1" | "2", number>>),
  "MIXED_KEYS": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "MIXED_KEYS"), (value) => value as Partial<Record<"true" | "true" | "1" | "one", number>>),
  "JSON_ENUM": Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "JSON_ENUM"), (value) => value as Array<1 | "1" | true | "true">),
})

/** Loads environment values when executed, converting config failures to defects. */
export const generated = config.pipe(Effect.orDie)
