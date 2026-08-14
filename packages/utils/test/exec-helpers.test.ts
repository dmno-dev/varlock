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
});
