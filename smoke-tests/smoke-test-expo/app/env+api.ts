import { ENV } from 'varlock/env';

/**
 * Server-only API route that demonstrates sensitive ENV access.
 *
 * GET  — returns env metadata (sensitive values available but not exposed)
 * POST — logs SECRET_KEY via console.log and captures the redacted output
 *
 * Try it:  curl http://localhost:8081/env
 */
export function GET() {
  return Response.json({
    apiUrl: ENV.API_URL,
    secretKeyAvailable: !!ENV.SECRET_KEY,
    secretKeyPreview: ENV.SECRET_KEY
      ? `${String(ENV.SECRET_KEY).slice(0, 6)}...`
      : null,
  });
}

export function POST() {
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
    origLog(...args);
  };

  console.log('The secret key is:', ENV.SECRET_KEY);

  console.log = origLog;

  return Response.json({
    rawValue: `${String(ENV.SECRET_KEY).slice(0, 4)}**** (truncated for demo)`,
    consoleOutput: logged,
  });
}
