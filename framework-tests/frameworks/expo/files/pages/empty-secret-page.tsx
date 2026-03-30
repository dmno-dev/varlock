import { ENV } from 'varlock/env';

// Tests that an empty optional sensitive var is handled correctly
const appName = ENV.APP_NAME;
const emptySecret = ENV.EMPTY_SECRET;
const emptyIsUndefined = emptySecret === undefined;

export default function Page() {
  return `${appName} - empty-is-undefined:${emptyIsUndefined}`;
}
