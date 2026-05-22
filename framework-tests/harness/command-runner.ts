import { spawn, type ChildProcess } from 'node:child_process';
import type { BuildResult } from './types.js';

/**
 * Kill a detached process group. Uses SIGKILL on the negative PID to ensure
 * all children (wrangler, workerd, etc.) are terminated and stdio pipes close.
 */
function killProcessGroup(child: ChildProcess) {
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch { /* already dead */ }
  } else {
    child.kill('SIGKILL');
  }
}

export interface RunCommandOptions {
  env?: Record<string, string>;
  timeout?: number;
  /** Kill the process shortly after this pattern appears in stdout/stderr */
  killAfterPattern?: RegExp;
}

export function runCommand(
  cwd: string,
  command: string,
  opts?: RunCommandOptions,
): Promise<BuildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      // Use detached so we can kill the entire process group (shell + children)
      // via process.kill(-pid). Without this, child.kill() only kills the shell
      // and grandchildren (e.g. wrangler/workerd) survive, keeping pipes open.
      detached: true,
      // Ignore stdin so commands that prompt for input get EOF immediately
      // instead of hanging (e.g. wrangler telemetry consent).
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Disable corepack so it doesn't reject pnpm/npm when the repo root
        // has a different packageManager (e.g. bun) in its package.json
        COREPACK_ENABLE_STRICT: '0',
        COREPACK_ENABLE_PROJECT_SPEC: '0',
        ...opts?.env,
      },
    });

    const stdoutChunks: Array<string> = [];
    const stderrChunks: Array<string> = [];

    const ANSI_RE = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
    let killScheduled = false;
    function checkKillPattern() {
      if (!opts?.killAfterPattern || killScheduled) return;
      const combined = (stdoutChunks.join('') + stderrChunks.join('')).replace(ANSI_RE, '');
      if (opts.killAfterPattern.test(combined)) {
        killScheduled = true;
        // brief delay to collect any trailing output, then force-kill the process group
        setTimeout(() => {
          killedByTimeout = true; // eslint-disable-line no-use-before-define
          killProcessGroup(child);
        }, 1000);
      }
    }

    child.stdout?.on('data', (data) => {
      stdoutChunks.push(data.toString());
      checkKillPattern();
    });
    child.stderr?.on('data', (data) => {
      stderrChunks.push(data.toString());
      checkKillPattern();
    });

    const timeout = opts?.timeout ?? 120_000;
    let killedByTimeout = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      killProcessGroup(child);
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = killedByTimeout ? 1 : (code ?? 1);
      resolve({
        exitCode,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        success: !killedByTimeout && exitCode === 0,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
