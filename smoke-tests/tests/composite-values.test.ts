import { describe, test, expect } from 'vitest';
import { varlockLoad, varlockRun, runVarlock } from '../helpers/run-varlock.js';

const CWD = 'smoke-test-composite-vals';

describe('composite (array/object) values', () => {
  test('load --format json outputs real arrays and objects', () => {
    const result = varlockLoad({ cwd: CWD, format: 'json' });
    expect(result.exitCode).toBe(0);
    const vars = JSON.parse(result.stdout);
    expect(vars.ALLOWED_EMAILS).toEqual(['admin@example.com', 'support@example.com']);
    expect(vars.SCORES).toEqual([10, 20]);
    expect(vars.ENDPOINTS).toEqual({ api: 'https://api.example.com' });
    // untyped array literal infers an array type
    expect(vars.UNTYPED_LIST).toEqual(['a', 'b']);
  });

  test('load --format env outputs flat string forms', () => {
    const result = varlockLoad({ cwd: CWD, format: 'env' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ALLOWED_EMAILS="admin@example.com,support@example.com"');
    // custom separator respected on output
    expect(result.stdout).toContain('SCORES="10;20"');
    // objects serialize as JSON (quotes escaped in env format)
    expect(result.stdout).toContain('ENDPOINTS="{\\"api\\":\\"https://api.example.com\\"}"');
  });

  test('run injects flat strings into the child process env', () => {
    const result = varlockRun([
      'node',
      '-e',
      'console.log([process.env.ALLOWED_EMAILS, process.env.SCORES, process.env.ENDPOINTS].join("\\n"))',
    ], { cwd: CWD });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('admin@example.com,support@example.com');
    expect(result.stdout).toContain('10;20');
    expect(result.stdout).toContain('{"api":"https://api.example.com"}');
  });

  test('a real env var override re-parses through the separator', () => {
    const result = varlockRun(
      ['node', '-e', 'console.log(process.env.SCORES)'],
      { cwd: CWD, env: { SCORES: '1;2;3' } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1;2;3');
  });

  test('a real env var override failing element validation errors', () => {
    const result = varlockLoad({ cwd: CWD, format: 'json' });
    expect(result.exitCode).toBe(0);
    const bad = runVarlock(['load'], { cwd: CWD, env: { ALLOWED_EMAILS: 'not-an-email, two@example.com' } });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.output).toContain('[0]');
  });
});

describe('dynamic @type parts', () => {
  test('relaxed constraints outside production', () => {
    const result = varlockLoad({ cwd: CWD });
    expect(result.exitCode).toBe(0);
  });

  test('strict constraints kick in when APP_ENV=production', () => {
    const result = runVarlock(['load'], { cwd: CWD, env: { APP_ENV: 'production' } });
    expect(result.exitCode).not.toBe(0);
    // empty ALERT_EMAILS violates the now-active minLength=1
    expect(result.output).toContain('ALERT_EMAILS');
    // SERVICE_HOST is now validated as a url
    expect(result.output).toContain('SERVICE_HOST');
  });
});

describe('sensitive composite redaction (end to end)', () => {
  test('leaking a single element of a sensitive array gets redacted in child output', () => {
    const result = varlockRun(
      ['node', '-e', 'console.log("leak attempt:", "tok-beta-7654321")'],
      { cwd: CWD },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('leak attempt:');
    expect(result.stdout).not.toContain('tok-beta-7654321');
  });
});
