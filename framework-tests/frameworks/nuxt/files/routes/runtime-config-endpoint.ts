// returns the public runtime config, to assert that env values captured at
// config-eval time (via varlock/auto-load in nuxt.config) made it through
export default defineEventHandler(() => useRuntimeConfig().public);
