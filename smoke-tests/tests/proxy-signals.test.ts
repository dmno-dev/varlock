import { describe, test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { VARLOCK_CLI } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const PROXY_CWD = join(SMOKE_TESTS_DIR, 'smoke-test-proxy');

// proxy run is not exercised on windows yet; scope the smoke test accordingly
const SKIP = process.platform === 'win32';

/**
 * Spawn `varlock proxy run -- <command>`, wait until the child prints a `ready` marker,
 * send `signal` to the varlock process itself, and resolve once it exits.
 * stdin is left non-interactive so varlock runs the child in its own process group.
 */
function runAndSignal(command: Array<string>, signal: NodeJS.Signals, env?: Record<string, string>) {
  return new Promise<{ output: string; code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [VARLOCK_CLI, 'proxy', 'run', '--', ...command], {
        cwd: PROXY_CWD,
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

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`timed out; output so far:\n${output}`));
      }, 60_000);
      child.on('exit', () => clearTimeout(timeout));
    },
  );
}

// Same contract as `varlock run` (see signals.test.ts): forward the signal, wait for the
// child's own shutdown handler, propagate its real exit status. Previously proxy run
// SIGKILLed the child the moment varlock received SIGTERM/SIGINT.
describe.skipIf(SKIP)('proxy run signal handling', () => {
  test('forwards SIGTERM and waits for a slow child shutdown, even with telemetry exit hooks registered', async () => {
    const result = await runAndSignal(
      ['bash', '-c', 'trap "echo bye-start; sleep 2; echo bye-done; exit 0" TERM; echo ready; sleep 60 & wait'],
      'SIGTERM',
      { DEBUG: 'varlock:telemetry' },
    );

    expect(result.output).toContain('bye-start');
    expect(result.output).toContain('bye-done');
    expect(result.code).toBe(0);
  });

  test('forwards SIGINT to the child', async () => {
    const result = await runAndSignal(
      ['bash', '-c', 'trap "echo interrupted; exit 0" INT; echo ready; sleep 60 & wait'],
      'SIGINT',
    );

    expect(result.output).toContain('interrupted');
    expect(result.code).toBe(0);
  });

  test('propagates 128+N when the child is killed by the forwarded signal', async () => {
    const result = await runAndSignal(
      ['bash', '-c', 'echo ready; sleep 60 & wait'],
      'SIGTERM',
    );

    // bash was terminated by SIGTERM (no trap) -> 128+15
    expect(result.code).toBe(143);
  });
});
