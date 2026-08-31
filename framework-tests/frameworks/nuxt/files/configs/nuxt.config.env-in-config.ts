// config-time env access via varlock/auto-load - the recommended way to use
// ENV inside nuxt.config itself (see the "Nuxt config timing" docs section)
import 'varlock/auto-load';
import { ENV } from 'varlock/env';

export default defineNuxtConfig({
  modules: ['@varlock/nuxt-integration'],
  compatibilityDate: '2025-01-01',
  runtimeConfig: {
    public: {
      varlockConfigProbe: ENV.PUBLIC_VAR,
    },
  },
});
