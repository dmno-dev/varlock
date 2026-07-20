// Side-effect import: registers the load-error hook BEFORE auto-load runs.
// Ordered above `import 'varlock/auto-load'` so ESM import hoisting can't run auto-load first.
globalThis._varlockOnLoadError = (err, env) => {
  console.log(`HOOK_FIRED dsn=${env.SENTRY_DSN} msg=${err?.message ?? err}`);
};
