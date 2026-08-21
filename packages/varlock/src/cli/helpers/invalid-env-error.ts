import ansis from 'ansis';

/**
 * Thrown when resolved config fails validation.
 *
 * Kept in its own module (rather than alongside the `checkFor*` helpers in
 * `error-checks.ts`) so the CLI entry point can catch it without importing
 * those helpers, which pull in the whole env-graph barrel.
 */
export class InvalidEnvError extends Error {
  constructor() {
    super('Resolved config/env did not pass validation');
  }
  getFormattedOutput() {
    return `\n💥 ${ansis.red(this.message)} 💥\n`;
  }
}
