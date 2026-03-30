import { spawn, type ChildProcess } from 'node:child_process';
import type { DevServerScenario, DevServerResult, DevServerRequestResult } from './types.js';

const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/;

/**
 * Gracefully kill a child process: SIGTERM first, SIGKILL after 3s.
 */
function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }

    const forceKillTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 3_000);

    child.on('close', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

/**
 * Fetch a URL with retries (server may report ready before accepting connections).
 */
async function fetchWithRetry(
  url: string,
  retries = 3,
  delayMs = 500,
): Promise<DevServerRequestResult> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url);
      const body = await resp.text();
      return { status: resp.status, body };
    } catch {
      if (i < retries - 1) {
        await new Promise<void>((r) => {
          setTimeout(r, delayMs);
        });
      }
    }
  }
  // final attempt — let it throw
  const resp = await fetch(url);
  const body = await resp.text();
  return { status: resp.status, body };
}

/**
 * Wait for a pattern in stdout/stderr that indicates the server is ready.
 * Returns the extracted server URL, or undefined if timed out.
 */
function waitForReady(
  child: ChildProcess,
  stdoutChunks: Array<string>,
  stderrChunks: Array<string>,
  pattern: string | RegExp,
  timeout: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    let resolved = false;
    function done(url: string | undefined) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer); // eslint-disable-line no-use-before-define
      // clean up listeners to avoid accumulation across scenarios
      child.stdout?.removeListener('data', onStdout); // eslint-disable-line no-use-before-define
      child.stderr?.removeListener('data', onStderr); // eslint-disable-line no-use-before-define
      child.removeListener('close', onClose); // eslint-disable-line no-use-before-define
      resolve(url);
    }

    function checkReady() {
      const combined = [...stdoutChunks, ...stderrChunks].join('');
      if (regex.test(combined)) {
        const urlMatch = combined.match(URL_PATTERN);
        done(urlMatch ? urlMatch[0] : undefined);
      }
    }

    const onStdout = () => checkReady();
    const onStderr = () => checkReady();
    const onClose = () => done(undefined);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('close', onClose);

    const timer = setTimeout(() => done(undefined), timeout);
  });
}

/**
 * Spawn a dev server, wait for it to be ready, run HTTP requests, then shut it down.
 */
export async function runDevServer(
  cwd: string,
  command: string,
  scenario: DevServerScenario,
): Promise<DevServerResult> {
  const readyTimeout = scenario.readyTimeout ?? 30_000;

  const stdoutChunks: Array<string> = [];
  const stderrChunks: Array<string> = [];

  let child: ChildProcess;
  try {
    child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        COREPACK_ENABLE_STRICT: '0',
        COREPACK_ENABLE_PROJECT_SPEC: '0',
        WRANGLER_SEND_METRICS: 'false',
        ...scenario.env,
      },
    });
  } catch (err) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      responses: [],
      error: `Failed to spawn: ${(err as Error).message}`,
    };
  }

  child.stdout?.on('data', (data) => stdoutChunks.push(data.toString()));
  child.stderr?.on('data', (data) => stderrChunks.push(data.toString()));

  const getStdout = () => stdoutChunks.join('');
  const getStderr = () => stderrChunks.join('');

  // safety net: kill child on process exit
  const exitHandler = () => {
    child.kill('SIGKILL');
  };
  process.on('exit', exitHandler);

  try {
    const serverUrl = await waitForReady(child, stdoutChunks, stderrChunks, scenario.readyPattern, readyTimeout);
    if (!serverUrl) {
      return {
        success: false,
        stdout: getStdout(),
        stderr: getStderr(),
        responses: [],
        error: `Server did not become ready within ${readyTimeout}ms`,
      };
    }

    const responses: Array<DevServerRequestResult> = [];
    for (const req of scenario.requests) {
      const url = `${serverUrl}${req.path}`;
      const result = await fetchWithRetry(url);
      responses.push(result);
    }

    return {
      success: true,
      stdout: getStdout(),
      stderr: getStderr(),
      responses,
      serverUrl,
    };
  } catch (err) {
    return {
      success: false,
      stdout: getStdout(),
      stderr: getStderr(),
      responses: [],
      error: (err as Error).message,
    };
  } finally {
    process.removeListener('exit', exitHandler);
    await killProcess(child);
  }
}
