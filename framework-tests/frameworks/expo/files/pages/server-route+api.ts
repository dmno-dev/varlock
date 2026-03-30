import { ENV } from 'varlock/env';

// In a +api server file, sensitive vars should be left as ENV.xxx (not replaced)
// and should NOT trigger a build-time warning.
const apiUrl = ENV.API_URL;
const secret = ENV.SECRET_KEY;

export function GET() {
  return Response.json({ apiUrl, hasSecret: !!secret });
}
