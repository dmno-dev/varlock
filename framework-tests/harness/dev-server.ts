import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DevServerScenario, DevServerResult, DevServerRequestResult } from './types.js';

const VERBOSE = !!process.env.FRAMEWORK_TEST_VERBOSE;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/;
// Strips all ANSI escape sequences: SGR (colors), CSI (cursor/erase), OSC (titles), etc.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\x1b\x9b][[(]?[0-9;?]*(?:[0-9A-ORZcf-nqry=><~]|#[0-9])/g;

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
      // SIGKILL the process group to ensure grandchildren (spawned via shell) are killed
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch { /* already dead */ }
      }
      child.kill('SIGKILL');
    }, 3_000);

    child.on('close', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    // Kill the process group (negative pid) so shell-spawned children also get the signal
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch { /* already dead */ }
    } else {
      child.kill('SIGTERM');
    }
  });
}

/**
 * Fetch a URL with retries (server may report ready before accepting connections).
 */
async function fetchWithRetry(
  url: string,
  retries = 3,
  delayMs = 500,
  timeoutMs = 15_000,
): Promise<DevServerRequestResult> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
      // strip ANSI codes so ready patterns aren't broken by color sequences
      const combined = [...stdoutChunks, ...stderrChunks].join('').replace(ANSI_PATTERN, '');
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
 * Wait for the ready pattern to appear in NEW output (after a given chunk offset).
 * Used after file edits to detect that the dev server has restarted.
 */
function waitForNewReady(
  child: ChildProcess,
  stdoutChunks: Array<string>,
  stderrChunks: Array<string>,
  stdoutOffset: number,
  stderrOffset: number,
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
      child.stdout?.removeListener('data', onData); // eslint-disable-line no-use-before-define
      child.stderr?.removeListener('data', onData); // eslint-disable-line no-use-before-define
      child.removeListener('close', onClose); // eslint-disable-line no-use-before-define
      resolve(url);
    }

    function checkNewOutput() {
      // only look at output produced after the edit, stripping ANSI codes
      const newOut = (stdoutChunks.slice(stdoutOffset).join('')
        + stderrChunks.slice(stderrOffset).join('')).replace(ANSI_PATTERN, '');
      if (regex.test(newOut)) {
        const urlMatch = newOut.match(URL_PATTERN);
        done(urlMatch ? urlMatch[0] : undefined);
      }
    }

    const onData = () => checkNewOutput();
    const onClose = () => done(undefined);

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('close', onClose);

    const timer = setTimeout(() => done(undefined), timeout);
  });
}

/**
 * Spawn a dev server, wait for it to be ready, run HTTP requests, then shut it down.
 * Supports mid-run file edits: if a request has `fileEdits`, files are written and
 * the runner waits for the server's readyPattern to reappear before making the request.
 */
export async function runDevServer(
  cwd: string,
  command: string,
  scenario: DevServerScenario,
): Promise<DevServerResult> {
  const readyTimeout = scenario.readyTimeout ?? 30_000;
  const log = (msg: string) => {
    if (VERBOSE) console.error(`[dev-server] ${msg}`);
  };
  const logError = (msg: string) => console.error(`[dev-server] ${msg}`);

  const stdoutChunks: Array<string> = [];
  const stderrChunks: Array<string> = [];

  log(`Spawning: ${command}`);
  let child: ChildProcess;
  try {
    child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      env: {
        ...process.env,
        COREPACK_ENABLE_STRICT: '0',
        COREPACK_ENABLE_PROJECT_SPEC: '0',
        WRANGLER_SEND_METRICS: 'false',
        VARLOCK_DEBUG: '1',
        ...scenario.env,
      },
    });
  } catch (err) {
    logError(`Failed to spawn: ${(err as Error).message}`);
    return {
      success: false,
      stdout: '',
      stderr: '',
      responses: [],
      error: `Failed to spawn: ${(err as Error).message}`,
    };
  }

  log(`Spawned pid=${child.pid}`);

  child.stdout?.on('data', (data) => stdoutChunks.push(data.toString()));
  child.stderr?.on('data', (data) => stderrChunks.push(data.toString()));
  child.on('close', (code, signal) => {
    log(`Process closed: code=${code}, signal=${signal}`);
  });

  const getStdout = () => stdoutChunks.join('');
  const getStderr = () => stderrChunks.join('');
  const dumpOutput = () => {
    const stdout = getStdout();
    const stderr = getStderr();
    logError(`Process status: exitCode=${child.exitCode}, killed=${child.killed}`);
    if (stdout) logError(`STDOUT:\n${stdout.slice(-2000)}`);
    if (stderr) logError(`STDERR:\n${stderr.slice(-2000)}`);
    if (!stdout && !stderr) logError('No output received from process at all');
  };

  // safety net: kill child on process exit
  const exitHandler = () => {
    child.kill('SIGKILL');
  };
  process.on('exit', exitHandler);

  try {
    log(`Waiting for ready pattern (timeout=${readyTimeout}ms)...`);
    const serverUrl = await waitForReady(child, stdoutChunks, stderrChunks, scenario.readyPattern, readyTimeout);
    if (!serverUrl) {
      logError(`Timeout waiting for ready pattern. Command: ${command}`);
      dumpOutput();
      return {
        success: false,
        stdout: getStdout(),
        stderr: getStderr(),
        responses: [],
        error: `Server did not become ready within ${readyTimeout}ms`,
      };
    }

    log(`Server ready at ${serverUrl}`);

    const responses: Array<DevServerRequestResult> = [];
    for (let i = 0; i < scenario.requests.length; i++) {
      const req = scenario.requests[i];

      // if this request has file edits, apply them and wait for the server to restart
      if (req.fileEdits) {
        const stdoutOffsetBefore = stdoutChunks.length;
        const stderrOffsetBefore = stderrChunks.length;

        for (const [filePath, content] of Object.entries(req.fileEdits)) {
          const fullPath = join(cwd, filePath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content);
        }

        log('File edits applied, waiting for server restart...');
        const newUrl = await waitForNewReady(
          child,
          stdoutChunks,
          stderrChunks,
          stdoutOffsetBefore,
          stderrOffsetBefore,
          scenario.readyPattern,
          readyTimeout,
        );
        if (!newUrl) {
          logError('Server did not restart after file edit');
          dumpOutput();
          return {
            success: false,
            stdout: getStdout(),
            stderr: getStderr(),
            responses,
            error: 'Server did not become ready again after file edit',
          };
        }
        log(`Server restarted at ${newUrl}`);
      }

      const url = `${serverUrl}${req.path}`;
      log(`Request ${i + 1}/${scenario.requests.length}: GET ${url}`);
      try {
        const result = await fetchWithRetry(url);
        log(`Response: status=${result.status}, body=${result.body.length} bytes`);
        responses.push(result);
      } catch (err) {
        logError(`Request failed: ${(err as Error).message}`);
        dumpOutput();
        throw err;
      }
    }

    // allow time for any async output (e.g. worker console.log piped through
    // varlock-wrangler's rewriteOutput) to flush before we kill the process
    await new Promise<void>((r) => {
      setTimeout(r, 500);
    });

    log('All requests completed successfully');
    return {
      success: true,
      stdout: getStdout(),
      stderr: getStderr(),
      responses,
      serverUrl,
    };
  } catch (err) {
    logError(`Error: ${(err as Error).message}`);
    return {
      success: false,
      stdout: getStdout(),
      stderr: getStderr(),
      responses: [],
      error: (err as Error).message,
    };
  } finally {
    log('Killing dev server...');
    process.removeListener('exit', exitHandler);
    await killProcess(child);
    log('Dev server killed');
  }
}
