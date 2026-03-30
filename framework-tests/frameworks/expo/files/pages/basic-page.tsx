import { ENV } from 'varlock/env';

const appName = ENV.APP_NAME;
const apiUrl = ENV.API_URL;
const hasSecret = !!ENV.SECRET_KEY;

console.log('secret-log-test:', ENV.SECRET_KEY);

export default function Page() {
  return `${appName} - ${apiUrl} - has-secret:${hasSecret}`;
}
