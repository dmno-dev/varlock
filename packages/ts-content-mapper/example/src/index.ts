import { ENV } from 'varlock/env';

// Every key below is typed from ../.env.schema by the content mapper. There is no env.d.ts.
const port: number = ENV.PORT;
const apiUrl: string = ENV.API_URL;
const signups: boolean = ENV.ENABLE_SIGNUPS;

function logLevelRank(level: typeof ENV.LOG_LEVEL) {
  switch (level) {
    case 'debug': return 0;
    case 'info': return 1;
    case 'warn': return 2;
    case 'error': return 3;
    default: return level satisfies never;
  }
}

// SENTRY_DSN is optional, so it has to be narrowed before use
const sentryTarget = ENV.SENTRY_DSN ? ENV.SENTRY_DSN.replace(/^https?:\/\//, '') : 'disabled';

export const summary = {
  port,
  apiUrl,
  signups,
  logLevel: logLevelRank(ENV.LOG_LEVEL),
  sentryTarget,
  env: ENV.APP_ENV,
  hasStripeKey: ENV.STRIPE_SECRET_KEY.startsWith('sk_'),
};
