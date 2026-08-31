// Config-time env access via varlock/auto-load, mapped into settings nuxt only
// reads while evaluating the config. `app.head.title` lands in the served HTML
// and `runtimeConfig.public` in the runtime config, so both are observable from
// a request - which is what makes dev-restart freshness testable.
import 'varlock/auto-load';
import { ENV } from 'varlock/env';

export default defineNuxtConfig({
  modules: ['@varlock/nuxt-integration'],
  compatibilityDate: '2025-01-01',
  app: {
    head: {
      title: ENV.PUBLIC_VAR,
    },
  },
  runtimeConfig: {
    public: {
      varlockConfigProbe: ENV.PUBLIC_VAR,
    },
  },
});
