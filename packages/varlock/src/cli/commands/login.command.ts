
import { setTimeout as delay } from 'node:timers/promises';
import ansis from 'ansis';
import { define } from 'gunshi';
import { logLines } from '../helpers/pretty-format';
import { CONFIG } from '../../config';
import { openUrl } from '../helpers/open-url';
import { keyPressed } from '../helpers/key-press';
import { TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';


export const commandSpec = define({
  name: 'login',
  description: 'Authenticate (using GitHub)',
  args: {},
});


export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const codeReq = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    body: JSON.stringify({
      client_id: CONFIG.GITHUB_APP_CLIENT_ID,
    }),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  if (codeReq.status !== 200) {
    console.log('Failed to initiate GitHub device flow login!');
    process.exit(1);
  }

  const ghCodeInfo = await codeReq.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  logLines([
    '🔑 Authenticating using GitHub:',
    '',
    `First please copy this code: ${ansis.bold.magenta(ghCodeInfo.user_code)}`,
    '',
    `Log in @ ${ghCodeInfo.verification_uri}`,
    '',
    'Press ENTER to open in your default browser...',
  ]);
  await keyPressed(['\r']);
  console.log(ansis.italic.gray('... please complete login on github.com ...'));
  openUrl(ghCodeInfo.verification_uri);

  const pollMs = ghCodeInfo.interval * 1000;
  const expiresMs = ghCodeInfo.expires_in * 1000;
  const startAt = new Date();

  let oauthStatus: any;
  while (true) {
    await delay(pollMs);
    try {
      const oauthStatusReq = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        body: JSON.stringify({
          client_id: CONFIG.GITHUB_APP_CLIENT_ID,
          device_code: ghCodeInfo.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      oauthStatus = await oauthStatusReq.json();
    } catch (err) {
      console.log(err);
    }

    // we are expecting to see { error: 'authorization_pending' }
    // probably a few more error types we could bail early on
    if (oauthStatus.error === 'access_denied') {
      console.log('❌ Login attempt was cancelled! Please try again.');
      process.exit(1);
    }

    // if we got the token, we break and continue
    if (oauthStatus.access_token) break;

    // if we've been polling for too long, give up
    if (new Date().getTime() - startAt.getTime() > expiresMs) {
      console.log('❌ Login timed out! Please try again.');
      process.exit(1);
    }
  }

  // oauthStatus when completed looks like:
  // {
  //   access_token: 'ghu_abcxyz',
  //   expires_in: 28800,
  //   refresh_token: 'ghr_abcxyz',
  //   refresh_token_expires_in: 15897600,
  //   token_type: 'bearer',
  //   scope: ''
  // }

  // pass along github auth info to API, which will fetch info from HG, handle login/signup, return JWT
  const authReq = await fetch(`${CONFIG.VARLOCK_API_URL}/github/auth-from-device-flow`, {
    method: 'POST',
    body: JSON.stringify({
      accessToken: oauthStatus.access_token,
      refreshToken: oauthStatus.refresh_token,
      accessTokenExpiresAt: new Date(Date.now() + oauthStatus.expires_in * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + oauthStatus.refresh_token_expires_in * 1000).toISOString(),
      tokenType: oauthStatus.token_type,
      scope: oauthStatus.scope,
    }),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  if (authReq.status !== 200) {
    console.log(await authReq.json());
    process.exit(1);
  }

  const authRes = await authReq.json() as {
    user: {
      githubUserId: string;
      githubUsername: string;
      name: string;
    },
    token: string;
    isNewUser: boolean;
    publicKey?: string;
  };

  // TODO: if app exists, pass off login info to it instead of storing in home folder
  // otherwise save login info in ~/.varlock/identity.json
  // also save it along with a new keypair if necessary, and send the public key to the api

  console.log(`✅ Logged in as ${authRes.user.githubUsername} (${authRes.user.name})!`);
};
