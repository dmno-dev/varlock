import { spawn } from 'node:child_process';
import type { BuildResult } from './types.js';

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
        // brief delay to collect any trailing output, then force-kill
        setTimeout(() => {
          killedByTimeout = true; // eslint-disable-line no-use-before-define
          // Use SIGKILL to ensure process tree dies (SIGTERM may not kill child processes like workerd)
          child.kill('SIGKILL');
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
      child.kill('SIGTERM');
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
