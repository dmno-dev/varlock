import { describe, test, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { varlockRun } from '../helpers/run-varlock.js';

// `varlock/auto-load` with `@redactLogs={stdout=true}` patches process.stdout/stderr, so writes
// that bypass `console` are redacted too, without a `varlock run` parent. Output is captured
// through pipes here, so the streams are not a TTY and redaction applies.

const SCENARIO_DIR = join(import.meta.dirname, '..', 'smoke-test-stream-redaction');
const SECRET = 'sk-live-abcdef1234567890';
const PRINTED = 'tok-printed-abcdef123456';

function hasBun(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runApp(runtime: string, env: Record<string, string> = {}) {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  delete childEnv.__VARLOCK_ENV;
  delete childEnv.__VARLOCK_REDACTED_STREAMS;
  if (!('_VARLOCK_REDACT_STDOUT' in env)) delete childEnv._VARLOCK_REDACT_STDOUT;
  const result = spawnSync(runtime === 'node' ? process.execPath : runtime, ['app.mjs'], {
    cwd: SCENARIO_DIR,
    env: childEnv as NodeJS.ProcessEnv,
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

describe('in-process stdout/stderr redaction', () => {
  test('redacts direct stream writes under node', () => {
    const result = runApp('node');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('stdout.write: sk▒▒▒▒▒');
    expect(result.output).toContain('stderr.write: sk▒▒▒▒▒');
    expect(result.output).toContain('buffer: sk▒▒▒▒▒');
    // a value split across writes: the part after the split is masked, and a warning says the
    // first part was already printed
    expect(result.output).toContain(`split: ${SECRET.slice(0, 10)}▒▒▒▒▒`);
    expect(result.output).toContain('[varlock] the sensitive value of API_KEY was split across separate writes');
    expect(result.output).not.toContain(SECRET);
    // @sensitive={redactLogs=false} lets a value through
    expect(result.output).toContain(`printed: ${PRINTED}`);
  });

  test.skipIf(!hasBun())('redacts direct stream writes and Bun.write under bun', () => {
    const result = runApp('bun');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('bun.write: sk▒▒▒▒▒');
    expect(result.output).toContain(`bun split: ${SECRET.slice(0, 10)}▒▒▒▒▒`);
    expect(result.output).toContain(`mixed split: ${SECRET.slice(0, 10)}▒▒▒▒▒`);
    expect(result.output).not.toContain(SECRET);
  });

  test('is off when the schema does not opt in', () => {
    const result = runApp('node', { REDACT_STDOUT: 'false' });
    expect(result.output).toContain(`stdout.write: ${SECRET}`);
    // console redaction is unaffected
    expect(result.output).toContain('console.log: sk▒▒▒▒▒');
  });

  test('_VARLOCK_REDACT_STDOUT=1 opts in without a schema change', () => {
    const result = runApp('node', { REDACT_STDOUT: 'false', _VARLOCK_REDACT_STDOUT: '1' });
    expect(result.output).not.toContain(SECRET);
  });

  test('under varlock run, the parent redacts and the child skips its own patch', () => {
    const result = varlockRun(['node', 'app.mjs'], { cwd: 'smoke-test-stream-redaction' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('stdout.write: sk▒▒▒▒▒');
    expect(result.output).not.toContain(SECRET);
    expect(result.output).toContain(`printed: ${PRINTED}`);
  });
});
