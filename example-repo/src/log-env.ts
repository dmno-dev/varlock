import { ENV, PUBLIC_ENV } from 'varlock';


export function logEnv() {

  console.log('\n\n')
  console.log('console.logging the API key: ', ENV.OPENAI_API_KEY, '\n\n');
  console.log('\n\n')

  console.log({
    'process.env.APP_ENV': process.env.APP_ENV,
    'process.env.SOME_VAR': process.env.SOME_VAR,
    'process.env.NOT_SENSITIVE_ITEM': process.env.NOT_SENSITIVE_ITEM,
    'process.env.SENSITIVE_ITEM': process.env.SENSITIVE_ITEM,
    'ENV.SENSITIVE_ITEM': ENV.SENSITIVE_ITEM,
    'PUBLIC_ENV.NOT_SENSITIVE_ITEM': PUBLIC_ENV.NOT_SENSITIVE_ITEM,
    // these trigger errors - uncomment to test
    // 'ENV.BAD_KEY': ENV.BAD_KEY,
    // 'PUBLIC_ENV.SENSITIVE_ITEM': PUBLIC_ENV.SENSITIVE_ITEM,
  });
}
