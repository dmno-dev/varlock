export default defineNuxtConfig({
  modules: ['@varlock/nuxt-integration'],
  compatibilityDate: '2025-01-01',
  varlock: { ssrInjectMode: 'resolved-env' },
});
