import { ENV } from 'varlock/env';

// Only uses non-sensitive vars — no warnings expected
export default function Page() {
  return `${ENV.APP_NAME} - ${ENV.API_URL}`;
}
