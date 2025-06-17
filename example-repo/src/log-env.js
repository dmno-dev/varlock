import { ENV } from 'varlock';

export function logEnv() {
  console.log({
    'process.env.APP_ENV': process.env.APP_ENV,
    'process.env.SOME_VAR': process.env.SOME_VAR,
    'process.env.NOT_SENSITIVE_ITEM': process.env.NOT_SENSITIVE_ITEM,
    'process.env.SENSITIVE_ITEM': process.env.SENSITIVE_ITEM,
    'ENV.SENSITIVE_ITEM': ENV.SENSITIVE_ITEM,
  });
}
