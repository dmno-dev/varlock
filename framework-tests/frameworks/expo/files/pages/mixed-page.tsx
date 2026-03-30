import { ENV } from 'varlock/env';

// Client page that uses both public and sensitive vars in a mixed build
// (alongside a +api server route). The plugin should warn about this file
// but NOT about the server route file.
const appName = ENV.APP_NAME;
const secret = ENV.SECRET_KEY;

export default function Page() {
  return `${appName} - has-secret:${!!secret}`;
}
