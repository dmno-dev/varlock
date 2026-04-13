import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');

export function runVarlock(args: Array<string>, options?: {
  cwd?: string;
  env?: Record<string, string>;
  captureOutput?: boolean;
}) {
  const cwd = options?.cwd ? join(SMOKE_TESTS_DIR, options.cwd) : SMOKE_TESTS_DIR;
  const env = { ...process.env, ...options?.env };

  if (options?.captureOutput) {
    const result = spawnSync('pnpm', ['exec', 'varlock', ...args], {
      cwd,
      env,
      encoding: 'utf-8',
      // On Windows, shell is needed to invoke pnpm.cmd. On Unix, avoid shell so that
      // argument strings like "process.exit(0)" are not misinterpreted as subshell syntax.
      shell: process.platform === 'win32',
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status ?? 1,
      output: result.stdout + result.stderr,
    };
  }

  try {
    const output = execSync(`pnpm exec varlock ${args.join(' ')}`, {
      cwd,
      env,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return {
      stdout: output,
      stderr: '',
      exitCode: 0,
      output,
    };
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.status || 1,
      output: (error.stdout || '') + (error.stderr || ''),
    };
  }
}

export function varlockLoad(options?: { cwd?: string; format?: string; paths?: Array<string> }) {
  const args = ['load'];
  if (options?.format) {
    args.push('--format', options.format);
  }
  if (options?.paths) {
    for (const p of options.paths) {
      args.push('--path', p);
    }
  }
  return runVarlock(args, { cwd: options?.cwd });
}

export function varlockRun(command: Array<string>, options?: {
  cwd?: string;
  env?: Record<string, string>;
}) {
  return runVarlock(['run', '--', ...command], {
    cwd: options?.cwd,
    env: options?.env,
    captureOutput: true,
  });
}

export function varlockPrintenv(varName: string, options?: {
  cwd?: string;
  path?: string;
  paths?: Array<string>;
}) {
  const args = ['printenv'];
  if (options?.paths) {
    for (const p of options.paths) {
      args.push('--path', p);
    }
  } else if (options?.path) {
    args.push('--path', options.path);
  }
  args.push(varName);
  return runVarlock(args, { cwd: options?.cwd, captureOutput: true });
}
