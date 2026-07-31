// TODO: figure out dev vs prod env vars... would be great to use varlock here!

// NOTE - these keys are safe to publish

export const CONFIG = {
  // VARLOCK_API_URL: 'http://localhost:8888',
  VARLOCK_API_URL: 'https://api.varlock.dev',
  GITHUB_APP_CLIENT_ID: 'Iv23li50gB8bMxLauiJQ', // varlock.dev app
  POSTHOG_API_KEY: 'phc_bfzH97VIta8yQa8HrsgmitqS6rTydjMISs0m8aqJTnq',
  /**
   * Telemetry collector endpoint. Overridable so tooling that needs the telemetry
   * code path to actually run (the benchmark suite measures its cost) can point it
   * at a local mock instead of the real collector. This is not an opt-out knob:
   * use VARLOCK_TELEMETRY_DISABLED to disable telemetry entirely.
   */
  POSTHOG_HOST: process.env.VARLOCK_POSTHOG_HOST || 'https://ph.varlock.dev',
};
