/**
 * Generated from .env.schema by Varlock for Effect 3. Do not edit by hand.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

export const config = Config.all({
  "EMPTY_ARRAY": Config.mapAttempt(Config.string("EMPTY_ARRAY"), (value) => JSON.parse(value) as Array<never>),
  "EMPTY_VALUES": Config.mapAttempt(Config.string("EMPTY_VALUES"), (value) => JSON.parse(value) as Record<string, never>),
  "EMPTY_KEYS": Config.mapAttempt(Config.string("EMPTY_KEYS"), (value) => JSON.parse(value) as Partial<Record<never, number>>),
  "NESTED": Config.mapAttempt(Config.string("NESTED"), (value) => JSON.parse(value) as Array<Record<string, Array<never>>>),
  "BOOLEAN_KEYS": Config.mapAttempt(Config.string("BOOLEAN_KEYS"), (value) => JSON.parse(value) as Partial<Record<"true" | "false", number>>),
  "NUMERIC_KEYS": Config.mapAttempt(Config.string("NUMERIC_KEYS"), (value) => JSON.parse(value) as Partial<Record<"1" | "2", number>>),
  "MIXED_KEYS": Config.mapAttempt(Config.string("MIXED_KEYS"), (value) => JSON.parse(value) as Partial<Record<"true" | "true" | "1" | "one", number>>),
  "JSON_ENUM": Config.mapAttempt(Config.string("JSON_ENUM"), (value) => JSON.parse(value) as Array<1 | "1" | true | "true">),
})

/** Loads environment values when executed, converting config failures to defects. */
export const generated = config.pipe(Effect.orDie)
