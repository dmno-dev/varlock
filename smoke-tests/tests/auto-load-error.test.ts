import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// End-to-end tests for how `varlock/auto-load` handles a load failure: by default it exits
// (fail-fast), but apps can opt in to having it THROW so an error tracker (e.g. Sentry) can
// report the failure — via a `globalThis._varlockOnLoadError` hook or `_VARLOCK_THROW_ON_LOAD_ERROR`.
// The scenario's `.env.schema` has a `@required` item left empty, so every run below fails to load
// unless `REQUIRED_THING` is provided.

const SCENARIO_DIR = join(import.meta.dirname, '..', 'smoke-test-auto-load-error');

function runNode(
  script: string,
  opts: { importModule?: string; env?: Record<string, string> } = {},
) {
  const args: Array<string> = [];
  if (opts.importModule) args.push('--import', opts.importModule);
  args.push(script);

  // Start from a copy of the env with the test-relevant knobs cleared, so an inherited value
  // (e.g. in CI) can't accidentally satisfy the schema or flip the opt-in.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.REQUIRED_THING;
  delete env._VARLOCK_THROW_ON_LOAD_ERROR;
  Object.assign(env, opts.env);

  const result = spawnSync(process.execPath, args, {
    cwd: SCENARIO_DIR,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

describe('varlock/auto-load load-failure reporting', () => {
  test('default: exits non-zero without throwing or reporting, and downstream never runs', () => {
    const { exitCode, output } = runNode('app-plain.mjs');
    expect(exitCode).not.toBe(0);
    expect(output).toContain('Configuration is currently invalid');
    expect(output).not.toContain('HOOK_FIRED');
    expect(output).not.toContain('DOWNSTREAM_RAN');
  });

  test('sync hook: fires with the resolved values, exits non-zero, downstream never runs', () => {
    const { exitCode, output } = runNode('app-hook.mjs');
    // regression guard: a synchronous hook must still exit non-zero (a thrown error swallowed by
    // the keep-alive handler would otherwise let the loop drain and exit 0)
    expect(exitCode).not.toBe(0);
    expect(output).toContain('HOOK_FIRED');
    expect(output).toContain('dsn=https://example@sentry.io/123');
    expect(output).not.toContain('DOWNSTREAM_RAN');
  });

  test('async hook: waits for the returned promise, then exits non-zero', () => {
    const { exitCode, output } = runNode('app-hook-async.mjs');
    expect(exitCode).not.toBe(0);
    // the async hook only logs after its (simulated flush) promise settles
    expect(output).toContain('HOOK_FIRED_ASYNC');
    expect(output).toContain('dsn=https://example@sentry.io/123');
    expect(output).not.toContain('DOWNSTREAM_RAN');
  });

  test('_VARLOCK_THROW_ON_LOAD_ERROR: throw is caught by a preloaded uncaughtException handler', () => {
    const { exitCode, output } = runNode('app-plain.mjs', {
      importModule: './instrument.mjs',
      env: { _VARLOCK_THROW_ON_LOAD_ERROR: '1' },
    });
    expect(exitCode).not.toBe(0);
    expect(output).toContain('HANDLER_CAUGHT');
    expect(output).not.toContain('DOWNSTREAM_RAN');
  });

  test('a preloaded uncaughtException handler alone (no opt-in) does NOT trigger the throw', () => {
    const { exitCode, output } = runNode('app-plain.mjs', {
      importModule: './instrument.mjs',
    });
    expect(exitCode).not.toBe(0);
    // without the flag, auto-load exits rather than throwing, so the handler never sees anything
    expect(output).not.toContain('HANDLER_CAUGHT');
    expect(output).not.toContain('DOWNSTREAM_RAN');
  });

  test('success: env is injected, downstream runs, and the hook is not called', () => {
    const { exitCode, output } = runNode('app-hook.mjs', { env: { REQUIRED_THING: 'ok' } });
    expect(exitCode).toBe(0);
    expect(output).toContain('DOWNSTREAM_RAN');
    expect(output).not.toContain('HOOK_FIRED');
  });
});
