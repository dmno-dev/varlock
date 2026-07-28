// Emulates an error tracker initialized via `node --import` (e.g. Sentry): registers an
// uncaughtException handler before the app (and varlock) load. Reports, then exits.
process.on('uncaughtException', (err) => {
  console.log(`HANDLER_CAUGHT msg=${err?.message ?? err}`);
  process.exit(1);
});
