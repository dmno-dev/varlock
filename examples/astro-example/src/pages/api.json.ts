import { ENV } from 'varlock/env';

// export const prerender = true;


export async function GET() {
  console.log('logging secret in api endpoint:', ENV.SECRET_FOO);

  // TODO: reenable http interceptor scanning
  // const apiResp = await fetch('https://api.sampleapis.com/beers/ale', {
  //   headers: {
  //     'x-custom-auth': ENV.SECRET_FOO,
  //     'x-another': 'bloop',
  //   },
  // });

  return new Response(JSON.stringify({
    APP_ENV: ENV.ENV_SPECIFIC_ITEM,
    // willCauseLeak: ENV.SECRET_FOO,
  }));
}
