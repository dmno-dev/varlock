/**
 * Generated from .env.schema by Varlock for Effect 3. Do not edit by hand.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

export const config = Config.succeed({})

/** Loads environment values when executed, converting config failures to defects. */
export const generated = config.pipe(Effect.orDie)
