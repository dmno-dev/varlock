import { describe, test, expect } from 'vitest';
import { spawnAsync, ExecError } from '../src/exec-helpers';

describe('spawnAsync', () => {
  test('passes input through stdin', async () => {
    const output = await spawnAsync(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { input: 'hello' },
    );
    expect(output).toBe('hello');
  });

  test('rejects rather than crashing when the child exits before reading stdin', async () => {
    // The input has to exceed the pipe buffer (64kb), otherwise the write lands in one shot
    // before the child dies and the broken pipe is never hit. Without an error listener on
    // stdin the resulting EPIPE is an unhandled error event that takes the process down,
    // which no try/catch around the await can reach.
    const result = await spawnAsync(
      process.execPath,
      ['-e', 'process.exit(1)'],
      { input: 'x'.repeat(1024 * 1024) },
    ).catch((err) => err);

    expect(result).toBeInstanceOf(ExecError);
    expect((result as ExecError).exitCode).toBe(1);
  });

  test('rejects when the child is killed by a signal after partial output', async () => {
    const result = await spawnAsync(
      process.execPath,
      ['-e', 'process.stdout.write("PARTIAL_", () => process.kill(process.pid, "SIGTERM"))'],
    ).catch((err) => err);

    expect(result).toBeInstanceOf(ExecError);
    expect((result as ExecError).signal).toBe('SIGTERM');
    expect((result as ExecError).exitCode).not.toBe(0);
    expect((result as ExecError).data).toContain('SIGTERM');
  });

  // `exit` can fire before the stdio pipes are drained, so settling on it used to drop
  // output under load (eg. bitwarden saw an empty stderr and could not tell the vault was
  // locked). To make that gap deterministic, the child exits immediately and a grandchild
  // sharing its stdio writes the output a little later, before the pipes close.
  const delayedWriteScript = (fd: 1 | 2, text: string, exitCode: number) => `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeSync(${fd}, ${JSON.stringify(text)}), 100)`)}], { stdio: 'inherit' }).unref();
    process.exit(${exitCode});
  `;

  test('rejection carries stderr written after the child exited but before the pipes closed', async () => {
    const result = await spawnAsync(
      process.execPath,
      ['-e', delayedWriteScript(2, 'Vault is locked.', 1)],
    ).catch((err) => err);

    expect(result).toBeInstanceOf(ExecError);
    expect((result as ExecError).exitCode).toBe(1);
    expect((result as ExecError).data).toBe('Vault is locked.');
  });

  test('resolves with stdout written after the child exited but before the pipes closed', async () => {
    const output = await spawnAsync(process.execPath, ['-e', delayedWriteScript(1, 'LATE_OUTPUT', 0)]);
    expect(output).toBe('LATE_OUTPUT');
  });

  test('does not hang when a grandchild keeps the stdio pipes open after the child exits', async () => {
    // the child spawns a detached grandchild that inherits stdout/stderr and outlives it,
    // like a CLI that starts a background daemon. `close` never fires in that case.
    const startAt = Date.now();
    const output = await spawnAsync(process.execPath, [
      '-e', `
      const { spawn } = require('node:child_process');
      const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'inherit', detached: true });
      gc.unref();
      process.stdout.write('DONE');
    `,
    ]);
    expect(output).toBe('DONE');
    expect(Date.now() - startAt).toBeLessThan(5000);
  });
});
