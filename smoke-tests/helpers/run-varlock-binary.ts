import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const BINARY_PATH = join(import.meta.dirname, '../../packages/varlock/dist-sea/varlock');

export function hasBinary(): boolean {
  return existsSync(BINARY_PATH);
}

export function runBinary(args: Array<string>, options?: {
  cwd?: string;
  env?: Record<string, string>;
}) {
  const cwd = options?.cwd ? join(SMOKE_TESTS_DIR, options.cwd) : SMOKE_TESTS_DIR;
  const env = { ...process.env, ...options?.env };

  const result = spawnSync(BINARY_PATH, args, {
    cwd,
    env,
    encoding: 'utf-8',
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

export function binaryRun(command: Array<string>, options?: {
  cwd?: string;
  env?: Record<string, string>;
}) {
  return runBinary(['run', '--', ...command], options);
}

export { BINARY_PATH };
