export default defineNuxtConfig({
  modules: ['@varlock/nuxt'],
  compatibilityDate: '2025-01-01',
  varlock: { ssrInjectMode: 'auto-load' },
});
