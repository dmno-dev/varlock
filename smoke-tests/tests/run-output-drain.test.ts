import { describe, test, expect } from 'vitest';
import { varlockRun, VARLOCK_CLI } from '../helpers/run-varlock.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const expected = `${JSON.stringify(['safe-piped-child-output'])}\n`;
const lateWrite = `setTimeout(() => {
  process.stdout.write(${JSON.stringify(expected)});
  process.stderr.write('tail:' + process.env.SECRET_TOKEN);
}, 60)`;

describe('Child output drainage', () => {
  test.each(['node', 'bun'])('%s drains real parent writes into a paused reader', async (runtime) => {
    const size = 8 * 1024 * 1024;
    const code = `process.stdout.write('x'.repeat(${size}) + '\\ntail:' + process.env.SECRET_TOKEN, () => process.exit(0))`;
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(runtime, [VARLOCK_CLI, 'run', '--', 'node', '-e', code], {
        cwd: join(import.meta.dirname, '../smoke-test-basic'),
        env: { ...process.env, VARLOCK_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdout.pause();
      const resume = setTimeout(() => {
        child.stdout.resume();
      }, 300);
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Paused-reader fixture exceeded its cap'));
      }, 10000);
      child.on('error', reject);
      child.on('close', (status) => {
        clearTimeout(timer);
        clearTimeout(resume);
        resolve({ status, stdout, stderr });
      });
    });
    expect(result.status).toBe(0);
    expect(result.stdout.slice(0, size)).toBe('x'.repeat(size));
    expect(result.stdout.slice(size)).toContain('\ntail:');
    expect(result.stdout).not.toContain('super-secret-token-12345');
    expect(result.stderr).toBe('');
  }, 10000);

  test.each(['node', 'bun'])('%s preserves the child status when stderr closes', async (runtime) => {
    const code = `process.stderr.write('first\\n', () => setTimeout(() => {
      process.stderr.write('second\\n');
      process.stdout.write('intact\\n', () => process.exit(7));
    }, 100))`;
    const result = await new Promise<{
      status: number | null;
      stdout: string;
      closedStderr: boolean;
    }>((resolve, reject) => {
      const child = spawn(runtime, [VARLOCK_CLI, 'run', '--', 'node', '-e', code], {
        cwd: join(import.meta.dirname, '../smoke-test-basic'),
        env: { ...process.env, VARLOCK_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let closedStderr = false;
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.once('data', () => {
        closedStderr = true;
        child.stderr.destroy();
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Closed-stderr fixture exceeded its cap'));
      }, 10000);
      child.on('error', reject);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, closedStderr });
      });
    });
    expect(result.closedStderr).toBe(true);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('intact\n');
  }, 10000);

  test.skipIf(process.platform === 'win32')('a signal after child exit cannot make incomplete output successful', async () => {
    const holder = 'setTimeout(() => {}, 6000)';
    const code = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(holder)}], {
      stdio: ['ignore', 1, 2], env: process.env,
    }); process.stdout.write('root:' + process.pid + '\\n', () => process.exit(0));`;
    const result = await new Promise<{ status: number | null; output: string; sent: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, [VARLOCK_CLI, 'run', '--', 'node', '-e', code], {
        cwd: join(import.meta.dirname, '../smoke-test-basic'),
        env: { ...process.env, VARLOCK_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let checking = false;
      let sent = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Late-signal fixture exceeded its cap'));
      }, 10000);
      const receive = async (chunk: Buffer) => {
        output += chunk.toString();
        const pid = /root:(\d+)/.exec(output)?.[1];
        if (!pid || checking) return;
        checking = true;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(Number(pid), 0);
          } catch (error: any) {
            if (error.code === 'ESRCH') {
              sent = child.kill('SIGINT');
              return;
            }
            reject(error);
            return;
          }
          await new Promise((resume) => {
            setTimeout(resume, 10);
          });
        }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.on('error', reject);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, output, sent });
      });
    });
    expect(result.sent).toBe(true);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Child output did not finish draining within 2000ms');
  }, 10000);

  test.each([0, 7])('preserves redacted inherited-pipe output after child exit %i', (exitCode) => {
    const child = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(lateWrite)}], {
      stdio: ['ignore', 1, 2], env: process.env,
    }); process.exit(${exitCode});`;
    const result = varlockRun(['node', '-e', child], {
      cwd: 'smoke-test-basic',
      env: { VARLOCK_TELEMETRY_DISABLED: '1' },
    });

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toContain('tail:');
    expect(result.output).not.toContain('super-secret-token-12345');
  });

  test('fails within the drain bound when a descendant keeps a pipe open', () => {
    const grandchild = 'setTimeout(() => {}, 6000)';
    const child = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {
      stdio: ['ignore', 1, 2], env: process.env,
    }); process.exit(0);`;
    const start = performance.now();
    const result = varlockRun(['node', '-e', child], {
      cwd: 'smoke-test-basic',
      env: { VARLOCK_TELEMETRY_DISABLED: '1' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Child output did not finish draining within 2000ms');
    expect(performance.now() - start).toBeLessThan(5000);
  }, 10000);
});
