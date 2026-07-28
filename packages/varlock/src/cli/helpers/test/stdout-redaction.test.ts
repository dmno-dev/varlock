import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';

import { parseEnvToggle, resolveStdoutRedaction } from '../stdout-redaction';

// resolveStdoutRedaction reads process.stdout.isTTY / process.stderr.isTTY and the
// _VARLOCK_REDACT_STDOUT env var, so we stub those and restore them after each test.
let origStdoutTTY: unknown;
let origStderrTTY: unknown;
let origEnv: string | undefined;

function setTTY(stdout: boolean, stderr: boolean) {
  (process.stdout as any).isTTY = stdout;
  (process.stderr as any).isTTY = stderr;
}

beforeEach(() => {
  origStdoutTTY = (process.stdout as any).isTTY;
  origStderrTTY = (process.stderr as any).isTTY;
  origEnv = process.env._VARLOCK_REDACT_STDOUT;
  delete process.env._VARLOCK_REDACT_STDOUT;
});

afterEach(() => {
  (process.stdout as any).isTTY = origStdoutTTY;
  (process.stderr as any).isTTY = origStderrTTY;
  if (origEnv === undefined) delete process.env._VARLOCK_REDACT_STDOUT;
  else process.env._VARLOCK_REDACT_STDOUT = origEnv;
});

describe('parseEnvToggle', () => {
  test('true-ish / false-ish / unset', () => {
    expect(parseEnvToggle('1')).toBe(true);
    expect(parseEnvToggle('true')).toBe(true);
    expect(parseEnvToggle(' TRUE ')).toBe(true);
    expect(parseEnvToggle('0')).toBe(false);
    expect(parseEnvToggle('false')).toBe(false);
    expect(parseEnvToggle(undefined)).toBeUndefined();
    expect(parseEnvToggle('maybe')).toBeUndefined();
  });
});

describe('resolveStdoutRedaction auto-detect (no override)', () => {
  test('piped streams are redacted, TTY streams are inherited (per stream)', () => {
    setTTY(false, false);
    expect(resolveStdoutRedaction({ redactStdoutFlag: undefined, redactLogs: true }))
      .toEqual({ redactStdout: true, redactStderr: true });

    setTTY(true, true);
    expect(resolveStdoutRedaction({ redactStdoutFlag: undefined, redactLogs: true }))
      .toEqual({ redactStdout: false, redactStderr: false });

    // mixed: interactive stdout, captured stderr
    setTTY(true, false);
    expect(resolveStdoutRedaction({ redactStdoutFlag: undefined, redactLogs: true }))
      .toEqual({ redactStdout: false, redactStderr: true });
  });

  test('@redactLogs=false disables auto redaction even when piped', () => {
    setTTY(false, false);
    expect(resolveStdoutRedaction({ redactStdoutFlag: undefined, redactLogs: false }))
      .toEqual({ redactStdout: false, redactStderr: false });
  });
});

describe('resolveStdoutRedaction overrides', () => {
  test('--no-redact-stdout (false) disables redaction on piped output', () => {
    setTTY(false, false);
    expect(resolveStdoutRedaction({ redactStdoutFlag: false, redactLogs: true }))
      .toEqual({ redactStdout: false, redactStderr: false });
  });

  test('--redact-stdout (true) forces redaction, overriding @redactLogs=false', () => {
    setTTY(false, false);
    expect(resolveStdoutRedaction({ redactStdoutFlag: true, redactLogs: false }))
      .toEqual({ redactStdout: true, redactStderr: true });
  });

  test('--redact-stdout errors when any stream is a TTY (cannot redact a raw TTY)', () => {
    setTTY(true, false);
    expect(() => resolveStdoutRedaction({ redactStdoutFlag: true, redactLogs: true }))
      .toThrow(/interactive terminal/i);
  });

  test('_VARLOCK_REDACT_STDOUT is honored, but the flag takes precedence', () => {
    setTTY(false, false);
    process.env._VARLOCK_REDACT_STDOUT = '0';
    // env says off
    expect(resolveStdoutRedaction({ redactStdoutFlag: undefined, redactLogs: true }))
      .toEqual({ redactStdout: false, redactStderr: false });
    // explicit flag beats the env var
    expect(resolveStdoutRedaction({ redactStdoutFlag: true, redactLogs: true }))
      .toEqual({ redactStdout: true, redactStderr: true });
  });
});
