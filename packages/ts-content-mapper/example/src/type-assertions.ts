// Compile-time checks: this file fails `tsc` if the mapper types any of these keys differently.
import { ENV } from 'varlock/env';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

export type TypeAssertions = [
  Expect<Equal<typeof ENV.PORT, number>>,
  Expect<Equal<typeof ENV.API_URL, string>>,
  Expect<Equal<typeof ENV.ENABLE_SIGNUPS, boolean>>,
  Expect<Equal<typeof ENV.LOG_LEVEL, 'debug' | 'info' | 'warn' | 'error'>>,
  Expect<Equal<typeof ENV.APP_ENV, 'development' | 'staging' | 'production'>>,
  Expect<Equal<typeof ENV.SENTRY_DSN, string | undefined>>,
  Expect<Equal<typeof ENV.STRIPE_SECRET_KEY, string>>,
];
