import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import {
  mkdirSync, writeFileSync, existsSync, cpSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { runVarlock } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const FIXTURE_DIR = 'smoke-test-plugin';
const tmpDirs: Array<string> = [];

/**
 * Creates a temporary project directory inside smoke-test-plugin/ with the
 * given .env.schema and a copy of the shared plugins folder.
 * Returns the relative path (from SMOKE_TESTS_DIR) for use with runVarlock.
 */
function createPluginTestProject(name: string, schema: string): string {
  const projectDir = join(SMOKE_TESTS_DIR, FIXTURE_DIR, `tmp-cli-${name}`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, '.env.schema'), schema, 'utf-8');

  const srcPlugins = join(SMOKE_TESTS_DIR, FIXTURE_DIR, 'plugins');
  const destPlugins = join(projectDir, 'plugins');
  if (!existsSync(destPlugins)) {
    cpSync(srcPlugins, destPlugins, { recursive: true });
  }

  tmpDirs.push(projectDir);
  return join(FIXTURE_DIR, `tmp-cli-${name}`);
}

describe('CLI plugin loading (non-binary)', () => {
  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('basic plugin (no imports)', () => {
    const cwd = FIXTURE_DIR;

    test('load resolves plugin values', () => {
      const result = runVarlock(['load', '--format', 'json'], { cwd });
      expect(result.exitCode).toBe(0);

      const env = JSON.parse(result.stdout);
      expect(env.BASIC_RESULT).toBe('hello-basic');
      expect(env.STATIC_VAR).toBe('static-value');
    });

    test('run injects plugin-resolved values into child process', () => {
      const result = runVarlock(
        ['run', '--', 'node', '-e', 'console.log("BASIC_RESULT=" + process.env.BASIC_RESULT)'],
        { cwd, captureOutput: true },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('BASIC_RESULT=hello-basic');
    });
  });

  describe('plugin with ESM imports of Node builtins', () => {
    let cwd: string;

    beforeAll(() => {
      cwd = createPluginTestProject('esm-imports', [
        '# @plugin(./plugins/esm-imports-plugin/)',
        '# @defaultSensitive=false',
        '# ---',
        'RESULT=esmTest("works")',
      ].join('\n'));
    });

    test('load resolves values using imported Node builtins', () => {
      const result = runVarlock(['load', '--format', 'json'], { cwd });
      expect(result.exitCode).toBe(0);

      const env = JSON.parse(result.stdout);
      expect(env.RESULT).toContain('works');
      expect(env.RESULT).toContain('b64=aGVsbG8=');
      expect(env.RESULT).toContain('hash=');
    });
  });

  describe('single-file plugin (.js, no package.json)', () => {
    let cwd: string;

    beforeAll(() => {
      cwd = createPluginTestProject('single-file', [
        '# @plugin(./plugins/single-file-plugin.js)',
        '# @defaultSensitive=false',
        '# ---',
        'RESULT=singleFileTest("works")',
      ].join('\n'));
    });

    test('load resolves single-file plugin values', () => {
      const result = runVarlock(['load', '--format', 'json'], { cwd });
      expect(result.exitCode).toBe(0);

      const env = JSON.parse(result.stdout);
      expect(env.RESULT).toContain('works');
      expect(env.RESULT).toContain('sep=');
    });
  });
});
