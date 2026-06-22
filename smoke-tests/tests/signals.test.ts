import { describe, test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { varlockRun, VARLOCK_CLI } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const BASIC_CWD = join(SMOKE_TESTS_DIR, 'smoke-test-basic');

/**
 * Spawn `varlock run -- <command>`, wait until the child prints a `ready` marker,
 * send `signal` to the varlock process itself, and resolve once it exits.
 * stdin is left non-interactive so varlock runs the child in its own process group.
 */
function runAndSignal(command: Array<string>, signal: NodeJS.Signals, env?: Record<string, string>) {
  return new Promise<{ output: string; code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [VARLOCK_CLI, 'run', '--', ...command], {
        cwd: BASIC_CWD,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });

      let output = '';
      let signalSent = false;
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (!signalSent && output.includes('ready')) {
          signalSent = true;
          child.kill(signal);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      child.on('error', reject);
      child.on('exit', (code, exitSignal) => resolve({ output, code, signal: exitSignal }));

      // safety net so a hung child can't wedge the suite
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`varlock run did not exit after ${signal} (output: ${JSON.stringify(output)})`));
      }, 15_000);
      timeout.unref();
    },
  );
}

// signals / process groups are POSIX concepts
describe.skipIf(process.platform === 'win32')('Signal handling', () => {
  test('forwards SIGTERM to the child so its handler runs and the exit code is preserved', async () => {
    const result = await runAndSignal(
      ['bash', '-c', 'trap "echo bye; exit 0" TERM; echo ready; sleep 60'],
      'SIGTERM',
    );

    // the child's TERM trap ran (graceful shutdown reached the app)
    expect(result.output).toContain('bye');
    // and we propagated its real exit status rather than a generic failure
    expect(result.code).toBe(0);
  });

  test('forwards SIGINT to the child', async () => {
    const result = await runAndSignal(
      ['bash', '-c', 'trap "echo interrupted; exit 0" INT; echo ready; sleep 60'],
      'SIGINT',
    );

    expect(result.output).toContain('interrupted');
    expect(result.code).toBe(0);
  });

  test('propagates 128+N when the child is killed by a signal (SIGTERM -> 143)', () => {
    const result = varlockRun(['bash', '-c', 'kill -TERM $$'], { cwd: 'smoke-test-basic' });
    expect(result.exitCode).toBe(143);
  });

  test('propagates 128+N for SIGINT (-> 130)', () => {
    const result = varlockRun(['bash', '-c', 'kill -INT $$'], { cwd: 'smoke-test-basic' });
    expect(result.exitCode).toBe(130);
  });

  test('still propagates normal non-zero exit codes', () => {
    const result = varlockRun(['bash', '-c', 'exit 7'], { cwd: 'smoke-test-basic' });
    expect(result.exitCode).toBe(7);
  });

  // by default we forward-and-wait with no self-imposed kill deadline: a child that
  // treats the signal as non-terminal (e.g. SIGHUP-as-reload, or simply ignores it)
  // must be allowed to keep running rather than getting SIGKILLed out from under us.
  test('does NOT force-kill a child that ignores the forwarded signal', async () => {
    const result = await runAndSignal(
      ['bash', '-c', 'trap "echo reloaded" HUP; echo ready; sleep 2; echo finished; exit 0'],
      'SIGHUP',
    );

    expect(result.output).toContain('reloaded');
    expect(result.output).toContain('finished');
    expect(result.code).toBe(0);
  });

  // escalation is opt-in via _VARLOCK_FORCE_KILL_TIMEOUT_MS
  test('escalates to SIGKILL when _VARLOCK_FORCE_KILL_TIMEOUT_MS is set and the child ignores the signal', async () => {
    const result = await runAndSignal(
      ['bash', '-c', 'trap "" TERM; echo ready; sleep 30'],
      'SIGTERM',
      { _VARLOCK_FORCE_KILL_TIMEOUT_MS: '1000' },
    );

    // killed by SIGKILL (signal 9) -> the wrapper reports 128+9 = 137
    expect(result.code).toBe(137);
  });
});
