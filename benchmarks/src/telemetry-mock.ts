import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type TelemetryMock = {
  /** Base URL to hand to varlock via VARLOCK_POSTHOG_HOST. */
  url: string;
  /** Number of capture requests received so far. */
  requestCount: () => number;
  close: () => Promise<void>;
};

/**
 * Local stand-in for the telemetry collector.
 *
 * Telemetry-on scenarios exist to measure what the telemetry code path costs
 * (payload building plus the exit hook that waits on the in-flight request).
 * Pointing that at the real collector would inject hundreds of synthetic events
 * into product analytics on every run, and would make the committed timings a
 * function of runner-to-collector network latency. A local mock keeps the code
 * path intact and the numbers comparable between runs.
 */
export async function startTelemetryMock(): Promise<TelemetryMock> {
  let count = 0;

  const server: Server = createServer((req, res) => {
    // Drain the body so the client sees a complete request/response cycle.
    req.resume();
    req.on('end', () => {
      count += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      // Shape of a real PostHog capture response.
      res.end('{"status":1}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requestCount: () => count,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
