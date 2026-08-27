import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { varlockRun, runVarlock } from '../helpers/run-varlock.js';

// End-to-end tests for how items that resolve to undefined (e.g. `UNSET_VAR=`) are
// injected into process.env. By default they are left unset everywhere (auto-load,
// `varlock run`, and shell exports) so `process.env.X ?? 'fallback'` works as
// documented; the `@injectUndefinedAsEmpty` root decorator opts back into
// dotenv-style empty-string injection.

const SCENARIO = 'smoke-test-undefined-injection';
const SCENARIO_DIR = join(import.meta.dirname, '..', SCENARIO);
const EMPTY_MODE = join(SCENARIO, 'empty-mode');

function runNodeApp(opts: { cwd?: string } = {}) {
  const env = { ...process.env };
  // an inherited value (e.g. if the test runner itself runs under varlock) must not
  // accidentally satisfy or flip the scenario under test
  for (const key of ['__VARLOCK_ENV', '_VARLOCK_ENV_KEY', 'SET_VAR', 'UNSET_VAR', 'EMPTY_VAR']) {
    delete env[key];
  }
  const result = spawnSync(process.execPath, ['app.mjs'], {
    cwd: opts.cwd ?? SCENARIO_DIR,
    env,
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

describe('items that resolve to undefined', () => {
  describe('default behavior: left out of process.env', () => {
    test('varlock run does not inject unset items', () => {
      const result = varlockRun(['node', 'app.mjs'], { cwd: SCENARIO });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('SET_VAR="set-value"');
      expect(result.output).toContain('UNSET_VAR=undefined');
      expect(result.output).toContain('UNSET_VAR_PRESENT=false');
      expect(result.output).toContain('UNSET_VAR_FALLBACK=fallback-value');
      // an explicit empty string is still injected as an empty string
      expect(result.output).toContain('EMPTY_VAR=""');
    });

    test('auto-load does not inject unset items', () => {
      const result = runNodeApp();
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('SET_VAR="set-value"');
      expect(result.output).toContain('UNSET_VAR=undefined');
      expect(result.output).toContain('UNSET_VAR_PRESENT=false');
      expect(result.output).toContain('UNSET_VAR_FALLBACK=fallback-value');
      expect(result.output).toContain('EMPTY_VAR=""');
      expect(result.output).toContain('ENV_UNSET_VAR=undefined');
    });

    test('shell format skips unset items', () => {
      const result = runVarlock(['load', '--format', 'shell'], { cwd: SCENARIO });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("export SET_VAR='set-value'");
      expect(result.stdout).not.toContain('UNSET_VAR');
      expect(result.stdout).toContain("export EMPTY_VAR=''");
    });

    test('env format keeps `KEY=` lines (round-trips to undefined in the varlock dialect)', () => {
      const result = runVarlock(['load', '--format', 'env'], { cwd: SCENARIO });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('UNSET_VAR=');
    });
  });

  describe('@injectUndefinedAsEmpty: injected as empty strings', () => {
    test('varlock run injects empty strings for unset items', () => {
      const result = varlockRun(['node', 'app.mjs'], { cwd: EMPTY_MODE });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('UNSET_VAR=""');
      expect(result.output).toContain('UNSET_VAR_PRESENT=true');
      expect(result.output).toContain('UNSET_VAR_FALLBACK=');
      // the typed ENV object still reflects the real resolved value
      expect(result.output).toContain('ENV_UNSET_VAR=undefined');
    });

    test('auto-load injects empty strings for unset items', () => {
      const result = runNodeApp({ cwd: join(SCENARIO_DIR, 'empty-mode') });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('UNSET_VAR=""');
      expect(result.output).toContain('UNSET_VAR_PRESENT=true');
      expect(result.output).toContain('ENV_UNSET_VAR=undefined');
    });

    test('shell format emits empty-string exports for unset items', () => {
      const result = runVarlock(['load', '--format', 'shell'], { cwd: EMPTY_MODE });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('export UNSET_VAR=');
    });
  });

  // The scenario dirs contain type-tests.ts files with positive assignments and
  // @ts-expect-error assertions pinning how each mode types process.env vs
  // import.meta.env. A `varlock load` generates env.d.ts (via @generateTsTypes),
  // then tsc --strict verifies the pair.
  describe('generated types match the injection mode', () => {
    const TSC = join(import.meta.dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');

    function typecheckScenario(scenarioDir: string) {
      const load = runVarlock(['load'], { cwd: scenarioDir });
      expect(load.exitCode).toBe(0);
      const fullDir = join(import.meta.dirname, '..', scenarioDir);
      expect(existsSync(join(fullDir, 'env.d.ts'))).toBe(true);
      const result = spawnSync(
        process.execPath,
        [TSC, '--noEmit', '--strict', 'env.d.ts', 'type-tests.ts'],
        { cwd: fullDir, encoding: 'utf-8' },
      );
      return {
        exitCode: result.status ?? 1,
        output: (result.stdout ?? '') + (result.stderr ?? ''),
      };
    }

    test('default: process.env keys stay optional', () => {
      const result = typecheckScenario(SCENARIO);
      expect(result.output.trim()).toBe('');
      expect(result.exitCode).toBe(0);
    });

    test('@injectUndefinedAsEmpty: process.env keys required with \'\' unions, import.meta.env unchanged', () => {
      const result = typecheckScenario(EMPTY_MODE);
      expect(result.output.trim()).toBe('');
      expect(result.exitCode).toBe(0);
    });
  });
});
