import { ENV } from 'varlock/env';

export default defineEventHandler(() => {
  console.log('secret-log-test:', ENV.SENSITIVE_VAR);
  return { ok: true };
});
