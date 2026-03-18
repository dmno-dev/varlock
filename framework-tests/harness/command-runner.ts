import { spawn } from 'node:child_process';
import type { BuildResult } from './types.js';

export interface RunCommandOptions {
  env?: Record<string, string>;
  timeout?: number;
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

    child.stdout?.on('data', (data) => {
      stdoutChunks.push(data.toString());
    });
    child.stderr?.on('data', (data) => {
      stderrChunks.push(data.toString());
    });

    const timeout = opts?.timeout ?? 120_000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;
      resolve({
        exitCode,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        success: exitCode === 0,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
