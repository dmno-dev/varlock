import { describe, test, expect } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { VARLOCK_CLI } from '../helpers/run-varlock.js';

// `varlock run` with piped (redacted) output must not exit before the child's output has
// been read and written onward (#1279).

const BASIC_CWD = join(import.meta.dirname, '..', 'smoke-test-basic');
const BIG = 2 * 1024 * 1024;
const WRITE_BIG = `process.stdout.write(Buffer.alloc(${BIG}, 120), () => process.stderr.write('child-done\\n'))`;

function hasBun(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function spawnVarlock(runtime: 'node' | 'bun', command: Array<string>) {
  return spawn(runtime === 'node' ? process.execPath : 'bun', [VARLOCK_CLI, 'run', '--', ...command], {
    cwd: BASIC_CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 15_000) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('varlock did not exit'));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe('varlock run piped output draining', () => {
  test('keeps output a background process writes after the child exits', async () => {
    const script = `
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => console.log("late line"), 300)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
      console.log('early line');
    `;
    const child = spawnVarlock('node', ['node', '-e', script]);
    let stdout = '';
    child.stdout!.on('data', (d) => {
      stdout += d.toString();
    });
    const { code } = await waitForExit(child);
    expect(code).toBe(0);
    expect(stdout.split('\n').filter(Boolean)).toEqual(['early line', 'late line']);
  });

  for (const runtime of ['node', 'bun'] as const) {
    test.skipIf(runtime === 'bun' && !hasBun())(`delivers all output to a slow reader under ${runtime}`, async () => {
      const child = spawnVarlock(runtime, ['node', '-e', WRITE_BIG]);
      const exited = waitForExit(child);
      // don't read for longer than exit-hook's 1s stdio flush window
      await new Promise((r) => {
        setTimeout(r, 2500);
      });
      let bytes = 0;
      child.stdout!.on('data', (d: Buffer) => {
        bytes += d.length;
      });
      const { code } = await exited;
      expect(code).toBe(0);
      expect(bytes).toBe(BIG);
    });
  }

  test('SIGTERM still exits varlock while it waits on a stalled reader', async () => {
    const child = spawnVarlock('node', ['node', '-e', WRITE_BIG]);
    const exited = waitForExit(child);
    // stdout is never read; wait until the child has handed off all its output and exited
    await new Promise<void>((resolve) => {
      let stderr = '';
      child.stderr!.on('data', (d) => {
        stderr += d.toString();
        if (stderr.includes('child-done')) resolve();
      });
    });
    await new Promise((r) => {
      setTimeout(r, 500);
    });
    child.kill('SIGTERM');
    const { code } = await exited;
    expect(code).toBe(143);
  });
});
