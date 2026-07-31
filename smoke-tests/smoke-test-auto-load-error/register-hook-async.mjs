// Async variant of the load-error hook: returns a promise (simulating Sentry's flush).
// auto-load must keep the process alive until it settles, then still exit non-zero.
globalThis._varlockOnLoadError = (err, env) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(`HOOK_FIRED_ASYNC dsn=${env.SENTRY_DSN} msg=${err?.message ?? err}`);
      resolve();
    }, 50);
  });
};
