import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { repeatMeasure } from './measure.ts';
import type { ScenarioMetrics } from './types.ts';

/** Poll until the URL answers with a non-error status. */
export async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastStatus: number | string = 'no response';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      // A 5xx means the server is up but the route is broken — keep polling so a
      // slow boot still succeeds, but report the status if we time out.
      if (res.ok) return;
      lastStatus = res.status;
    } catch (err) {
      lastStatus = (err as Error).message;
    }
    await new Promise<void>((r) => {
      setTimeout(r, 250);
    });
  }
  throw new Error(`Timed out waiting for ${url} (last: ${lastStatus})`);
}

/** Measure request latency against an already-running server. */
export async function measurePathLatency(
  baseUrl: string,
  path: string,
  iterations: number,
  warmup: number,
): Promise<ScenarioMetrics> {
  return repeatMeasure(
    async () => {
      const start = performance.now();
      const res = await fetch(`${baseUrl}${path}`);
      const body = await res.text();
      const wallMs = performance.now() - start;
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      return { wallMs, rssPeakBytes: null, exitCode: 0 };
    },
    { iterations, warmup },
  );
}

export type ServerOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  /** URL polled until it answers before `fn` runs. */
  readyUrl: string;
  readyTimeoutMs?: number;
};

/**
 * Run a dev/prod server for the duration of `fn`, then tear down the whole
 * process group.
 *
 * Two things here are load-bearing:
 * - stdout AND stderr are drained. The redactLogs benches make the server write
 *   hundreds of log lines per request; an unread pipe fills at ~64KB and the
 *   server then blocks on write(), which would turn a latency measurement into a
 *   measurement of pipe backpressure.
 * - the child is detached and killed by process group. `npx next start` and
 *   `npx vite dev` both exec the real server as a grandchild, so signalling only
 *   the direct child leaves an orphan holding the port and burning CPU during
 *   later scenarios.
 */
export async function withServer<T>(
  command: Array<string>,
  options: ServerOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const [bin, ...args] = command;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(options.env)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const server: ChildProcess = spawn(bin!, args, {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let output = '';
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
    // Bound the buffer — these servers can be very chatty under the log benches.
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  server.stdout?.on('data', capture);
  server.stderr?.on('data', capture);

  const exited = once(server, 'exit');
  let exitedEarly = false;
  exited.then(
    () => {
      exitedEarly = true;
    },
    () => {
      exitedEarly = true;
    },
  );

  try {
    await waitForUrl(options.readyUrl, options.readyTimeoutMs ?? 90_000);
    return await fn();
  } catch (err) {
    throw new Error(`${String(err)}\nserver output:\n${output.slice(-8_000)}`);
  } finally {
    if (!exitedEarly && server.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        server.kill('SIGTERM');
      }
      const timer = new Promise<'timeout'>((r) => {
        setTimeout(() => r('timeout'), 5_000);
      });
      const result = await Promise.race([exited.then(() => 'exited' as const), timer]);
      if (result === 'timeout') {
        try {
          process.kill(-server.pid, 'SIGKILL');
        } catch {
          server.kill('SIGKILL');
        }
        await Promise.race([exited, timer]).catch(() => undefined);
      }
    }
  }
}
