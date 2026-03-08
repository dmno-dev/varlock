import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import {
  mkdirSync, writeFileSync, existsSync, cpSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  runBinary, binaryRun, hasBinary,
} from '../helpers/run-varlock-binary.js';

const FIXTURE_DIR = 'smoke-test-plugin';
const tmpDirs: Array<string> = [];

/**
 * Helper: creates a temporary project directory (under smoke-test-plugin/tmp-<name>)
 * with the given .env.schema content and a symlink (copy) of the plugins folder.
 * Returns the relative cwd path for use with runBinary/binaryRun.
 */
function createPluginTestProject(name: string, schema: string): string {
  const smokeTestDir = join(import.meta.dirname, '..');
  const projectDir = join(smokeTestDir, FIXTURE_DIR, `tmp-${name}`);

  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, '.env.schema'), schema, 'utf-8');

  // Copy the plugins folder into the temp project so relative paths resolve
  const srcPlugins = join(smokeTestDir, FIXTURE_DIR, 'plugins');
  const destPlugins = join(projectDir, 'plugins');
  if (!existsSync(destPlugins)) {
    cpSync(srcPlugins, destPlugins, { recursive: true });
  }

  tmpDirs.push(projectDir);
  return join(FIXTURE_DIR, `tmp-${name}`);
}

describe('Binary plugin loading', () => {
  beforeAll(() => {
    if (!hasBinary()) {
      throw new Error('Binary not found — run `bun run build:binary` in packages/varlock first');
    }
  });

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('basic plugin (no imports)', () => {
    const cwd = FIXTURE_DIR;

    test('load resolves plugin values', () => {
      const result = runBinary(['load', '--format', 'json'], { cwd });
      expect(result.exitCode).toBe(0);

      const env = JSON.parse(result.stdout);
      expect(env.BASIC_RESULT).toBe('hello-basic');
      expect(env.STATIC_VAR).toBe('static-value');
    });

    test('run injects plugin-resolved values into child process', () => {
      const result = binaryRun(
        ['node', '-e', 'console.log("BASIC_RESULT=" + process.env.BASIC_RESULT)'],
        { cwd },
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
      const result = runBinary(['load', '--format', 'json'], { cwd });
      expect(result.exitCode).toBe(0);

      const env = JSON.parse(result.stdout);
      // The resolver exercises path.join, Buffer, and crypto
      expect(env.RESULT).toContain('works');
      expect(env.RESULT).toContain('path=/tmp/test');
      expect(env.RESULT).toContain('b64=aGVsbG8='); // Buffer.from('hello').toString('base64')
      expect(env.RESULT).toContain('hash='); // crypto hash present
    });

    test('run injects values into child process', () => {
      const result = binaryRun(
        ['node', '-e', 'console.log("R=" + process.env.RESULT)'],
        { cwd },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('R=works:path=');
    });
  });

  describe('plugin using import.meta.url + createRequire', () => {
    let cwd: string;

    beforeAll(() => {
      cwd = createPluginTestProject('import-meta', [
        '# @plugin(./plugins/import-meta-plugin/)',
        '# @defaultSensitive=false',
        '# ---',
        'RESULT=metaTest("works")',
      ].join('\n'));
    });

    test('import.meta.url resolves to correct plugin directory', () => {
      const result = runBinary(['load', '--format', 'json'], { cwd });
      expect(result.exitCode).toBe(0);

      const env = JSON.parse(result.stdout);
      expect(env.RESULT).toContain('works');
      expect(env.RESULT).toContain('dirname_ok=true');
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
      const result = runBinary(['load', '--format', 'json'], { cwd });
      expect(result.exitCode).toBe(0);

      const env = JSON.parse(result.stdout);
      expect(env.RESULT).toContain('works');
      expect(env.RESULT).toContain('sep=');
    });
  });

  describe('multiple plugins in same schema', () => {
    let cwd: string;

    beforeAll(() => {
      cwd = createPluginTestProject('multi-plugin', [
        '# @plugin(./plugins/basic-plugin/)',
        '# @plugin(./plugins/esm-imports-plugin/)',
        '# @defaultSensitive=false',
        '# ---',
        'FROM_BASIC=test("basic-val")',
        'FROM_ESM=esmTest("esm-val")',
        'PLAIN=plain-value',
      ].join('\n'));
    });

    test('both plugins load and resolve correctly', () => {
      const result = runBinary(['load', '--format', 'json'], { cwd });
      expect(result.exitCode).toBe(0);

      const env = JSON.parse(result.stdout);
      expect(env.FROM_BASIC).toBe('basic-val');
      expect(env.FROM_ESM).toContain('esm-val');
      expect(env.PLAIN).toBe('plain-value');
    });
  });
});
