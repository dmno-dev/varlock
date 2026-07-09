import {
  describe, test, expect, beforeEach,
} from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  varlockLoad, varlockRun, varlockPrintenv, varlockCodegen, runVarlock, VARLOCK_CLI,
} from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');

describe('CLI Commands', () => {
  test('varlock --help should work', () => {
    const result = runVarlock(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('varlock');
  });

  describe('shell completion', () => {
    test('varlock complete bash generates bash completion script', () => {
      const result = runVarlock(['complete', 'bash']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bash completion for varlock');
      expect(result.stdout).toContain('__varlock');
    });

    test('varlock complete zsh generates zsh completion script', () => {
      const result = runVarlock(['complete', 'zsh']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('#compdef varlock');
      expect(result.stdout).toContain('_varlock');
    });

    test('varlock complete fish generates fish completion script', () => {
      const result = runVarlock(['complete', 'fish']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('complete -c varlock');
    });

    test('varlock complete -- suggests subcommands at runtime', () => {
      const result = runVarlock(['complete', '--', 'lo']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('load');
      expect(result.stdout).toContain('lock');
    });

    test('complete appears in varlock --help', () => {
      const result = runVarlock(['--help']);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('complete');
    });
  });

  test('varlock load should succeed', () => {
    const result = varlockLoad({ cwd: 'smoke-test-basic' });
    expect(result.exitCode).toBe(0);
  });

  describe('package.json loadPath config', () => {
    test('varlock load respects loadPath from package.json', () => {
      const result = varlockLoad({ cwd: 'smoke-test-pkg-json-config' });
      expect(result.exitCode).toBe(0);
    });

    test('varlock printenv resolves variable using loadPath from package.json', () => {
      const result = varlockPrintenv('PKG_JSON_VAR', { cwd: 'smoke-test-pkg-json-config' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello-from-pkg-json-config');
    });
  });

  describe('multiple --path flags', () => {
    test('varlock load with multiple paths loads vars from all paths', () => {
      const result = varlockLoad({
        cwd: 'smoke-test-multi-path',
        format: 'json',
        paths: ['./base/', './overrides/'],
      });
      expect(result.exitCode).toBe(0);
      const vars = JSON.parse(result.stdout);
      expect(vars.BASE_VAR).toBe('from-base');
      expect(vars.OVERRIDE_VAR).toBe('from-overrides');
    });

    test('later paths take higher precedence for shared vars', () => {
      const result = varlockPrintenv('SHARED_VAR', {
        cwd: 'smoke-test-multi-path',
        paths: ['./base/', './overrides/'],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('from-overrides');
    });

    test('single --path still works', () => {
      const result = varlockPrintenv('BASE_VAR', {
        cwd: 'smoke-test-multi-path',
        paths: ['./base/'],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('from-base');
    });

    test('--path flag overrides package.json loadPath', () => {
      const result = varlockPrintenv('BASE_VAR', {
        cwd: 'smoke-test-pkg-json-config',
        paths: ['../smoke-test-multi-path/base/'],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('from-base');
    });
  });

  test('varlock load --format json should output valid JSON', () => {
    const result = varlockLoad({ cwd: 'smoke-test-basic', format: 'json' });
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test('varlock load --format shell should output export statements', () => {
    const result = varlockLoad({ cwd: 'smoke-test-basic', format: 'shell' });
    expect(result.exitCode).toBe(0);
    // Every non-empty line should start with "export "
    const lines = result.stdout.trim().split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^export [A-Z_]+=.*/);
    }
  });

  describe('printenv command', () => {
    test('varlock printenv prints a public variable value', () => {
      const result = varlockPrintenv('PUBLIC_VAR', { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('public-value');
    });

    test('varlock printenv prints a sensitive variable value', () => {
      const result = varlockPrintenv('SECRET_TOKEN', { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('super-secret-token-12345');
    });

    test('varlock printenv with --path flag prints variable value', () => {
      const result = varlockPrintenv('PUBLIC_VAR', {
        cwd: 'smoke-test-basic',
        path: '.env.schema',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('public-value');
    });

    test('varlock printenv with unknown variable returns error', () => {
      const result = varlockPrintenv('DOES_NOT_EXIST', { cwd: 'smoke-test-basic' });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('DOES_NOT_EXIST');
    });

    test('varlock printenv with no variable name returns error', () => {
      const result = runVarlock(['printenv'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('Missing required argument');
    });
  });

  describe('explain command', () => {
    test('varlock explain <key> resolves a config item', () => {
      const result = runVarlock(['explain', 'PUBLIC_VAR'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('PUBLIC_VAR');
      expect(result.output).toContain('public-value');
    });

    test('varlock explain with no key returns error', () => {
      const result = runVarlock(['explain'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('Missing required argument');
    });
  });

  describe('scan command', () => {
    // Positional targets scope the scan to specific files/dirs. test-script.js contains the
    // resolved secret value in plaintext; stdin-test.js does not.
    test('varlock scan <file> flags a plaintext secret in the targeted file', () => {
      const result = runVarlock(['scan', './test-script.js'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('test-script.js');
      expect(result.output).toContain('SECRET_TOKEN');
    });

    test('varlock scan <file> passes for a targeted file with no plaintext secrets', () => {
      const result = runVarlock(['scan', './stdin-test.js'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('No sensitive values found');
    });
  });

  describe('audit command', () => {
    test('varlock audit <dir> accepts a positional target and reports in-sync', () => {
      const result = runVarlock(['audit', './'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('in sync');
    });
  });

  describe('run command', () => {
    // Nested-varlock invocations use the installed CLI (absolute path), not the un-built
    // source tree — `packages/varlock/bin/cli.js` imports ../dist which CI never builds.
    const LOCAL_VARLOCK_CLI = VARLOCK_CLI;

    test('varlock run should forward child stdout', () => {
      const result = varlockRun(['node', '-p', '1+1'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe('2');
    });

    test('varlock run should propagate non-zero exit code', () => {
      const result = varlockRun(['node', '-e', 'process.exit(42)'], {
        cwd: 'smoke-test-basic',
      });
      expect(result.exitCode).toBe(42);
    });

    test('varlock run should forward child stderr', () => {
      const result = varlockRun(
        ['node', '-e', "process.stderr.write('error-output\\n')"],
        { cwd: 'smoke-test-basic' },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('error-output');
    });

    test('nested varlock run does not treat injected vars as process.env overrides', () => {
      const result = runVarlock([
        'run',
        '--inject',
        'all',
        '--',
        'node',
        LOCAL_VARLOCK_CLI,
        'load',
        '--format',
        'json',
        '--path',
        '../overrides/.env.schema',
      ], {
        cwd: 'smoke-test-multi-path/base',
      });

      expect(result.exitCode).toBe(0);
      const vars = JSON.parse(result.stdout);
      expect(vars.SHARED_VAR).toBe('from-overrides');
    });

    test('nested varlock run preserves real outer shell overrides', () => {
      const result = runVarlock([
        'run',
        '--inject',
        'all',
        '--',
        'node',
        LOCAL_VARLOCK_CLI,
        'load',
        '--format',
        'json',
        '--path',
        '../overrides/.env.schema',
      ], {
        cwd: 'smoke-test-multi-path/base',
        env: {
          SHARED_VAR: 'from-shell',
        },
      });

      expect(result.exitCode).toBe(0);
      const vars = JSON.parse(result.stdout);
      expect(vars.SHARED_VAR).toBe('from-shell');
    });

    test('nested varlock run keeps inner command-local overrides over outer shell overrides', () => {
      const result = runVarlock([
        'run',
        '--inject',
        'all',
        '--',
        'sh',
        '-c',
        // Forward-slash the (absolute, possibly Windows) path so it survives the sh string;
        // backslashes would be eaten by the shell. node accepts `C:/...` on Windows.
        `SHARED_VAR=from-shell-inner node "${LOCAL_VARLOCK_CLI.replace(/\\/g, '/')}" load --format json --path ../overrides/.env.schema`,
      ], {
        cwd: 'smoke-test-multi-path/base',
        env: {
          SHARED_VAR: 'from-shell-outer',
        },
      });

      expect(result.exitCode).toBe(0);
      const vars = JSON.parse(result.stdout);
      expect(vars.SHARED_VAR).toBe('from-shell-inner');
    });

    test('strips @internal vars from the child env even when set ambiently', () => {
      // child exits 0 only if OP_TOKEN is ABSENT (exit code can't be redacted, unlike stdout)
      const result = runVarlock(['run', '--', 'node', '-e', 'process.exit(process.env.OP_TOKEN ? 1 : 0)'], {
        cwd: 'smoke-test-internal',
        env: { OP_TOKEN: 'secret-zero' },
      });
      expect(result.exitCode).toBe(0);
    });

    test('--include-internal passes @internal vars through to the child', () => {
      // child exits 0 only if OP_TOKEN is PRESENT
      const result = runVarlock(['run', '--include-internal', '--', 'node', '-e', 'process.exit(process.env.OP_TOKEN ? 0 : 1)'], {
        cwd: 'smoke-test-internal',
        env: { OP_TOKEN: 'secret-zero' },
      });
      expect(result.exitCode).toBe(0);
    });

    test('--format json-full excludes @internal vars by default', () => {
      // framework integrations shell out to exactly this command to get their injected config -
      // an @internal secret-zero credential must not appear here unless explicitly requested
      const result = runVarlock(['load', '--format', 'json-full'], {
        cwd: 'smoke-test-internal',
        env: { OP_TOKEN: 'secret-zero' },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.config).not.toHaveProperty('OP_TOKEN');
      expect(parsed.config.PUBLIC_VAR.value).toBe('visible');
    });

    test('--format json-full --include-internal includes @internal vars, flagged', () => {
      const result = runVarlock(['load', '--format', 'json-full', '--include-internal'], {
        cwd: 'smoke-test-internal',
        env: { OP_TOKEN: 'secret-zero' },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.config.OP_TOKEN).toMatchObject({ value: 'secret-zero', isInternal: true });
    });

    // `--no-inject-graph` is deprecated and hidden from help, but still supported for
    // back-compat. Guard that it keeps working and omits the __VARLOCK_ENV blob.
    test('--no-inject-graph still works and omits the __VARLOCK_ENV blob', () => {
      const probe = "process.stdout.write('BLOB=' + (!!process.env.__VARLOCK_ENV) + ' RUN=' + process.env.__VARLOCK_RUN)";

      const withBlob = runVarlock(['run', '--', 'node', '-e', probe], { cwd: 'smoke-test-basic' });
      expect(withBlob.exitCode).toBe(0);
      expect(withBlob.output).toContain('BLOB=true');

      const noBlob = runVarlock(['run', '--no-inject-graph', '--', 'node', '-e', probe], { cwd: 'smoke-test-basic' });
      expect(noBlob.exitCode).toBe(0);
      expect(noBlob.output).toContain('BLOB=false');
      // __VARLOCK_RUN is always set regardless of the flag
      expect(noBlob.output).toContain('RUN=1');
    });
  });

  describe('type generation', () => {
    const typeFilePath = join(SMOKE_TESTS_DIR, 'smoke-test-basic', 'env.d.ts');
    const typeFilePathAutoFalse = join(SMOKE_TESTS_DIR, 'smoke-test-typegen-auto', 'env.d.ts');

    beforeEach(() => {
      // Clean up generated type files before each test
      if (existsSync(typeFilePath)) rmSync(typeFilePath);
      if (existsSync(typeFilePathAutoFalse)) rmSync(typeFilePathAutoFalse);
    });

    // Note: no `expect(existsSync).toBe(false)` pre-check here — `smoke-test-basic` is a shared
    // fixture that other test files (redaction/runtime/signals/…) also run load/run in, regenerating
    // env.d.ts in parallel. The negative pre-check would race; asserting generation (toBe(true)) is
    // the actual behavior under test. The auto=false tests below use an isolated dir, so they can.
    test('varlock load generates type file when @generateTypes is set', () => {
      const result = varlockLoad({ cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(existsSync(typeFilePath)).toBe(true);
    });

    test('varlock run generates type file when @generateTypes is set', () => {
      const result = varlockRun(['node', '-e', 'process.exit(0)'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(existsSync(typeFilePath)).toBe(true);
    });

    test('varlock load skips type generation when auto=false', () => {
      expect(existsSync(typeFilePathAutoFalse)).toBe(false);
      const result = varlockLoad({ cwd: 'smoke-test-typegen-auto' });
      expect(result.exitCode).toBe(0);
      expect(existsSync(typeFilePathAutoFalse)).toBe(false);
    });

    test('varlock run skips type generation when auto=false', () => {
      expect(existsSync(typeFilePathAutoFalse)).toBe(false);
      const result = varlockRun(['node', '-e', 'process.exit(0)'], { cwd: 'smoke-test-typegen-auto' });
      expect(result.exitCode).toBe(0);
      expect(existsSync(typeFilePathAutoFalse)).toBe(false);
    });

    test('varlock typegen generates polyglot types with non-string fields', () => {
      const polyglotDir = join(SMOKE_TESTS_DIR, 'smoke-test-typegen-polyglot');
      // each generated module: typed coerced fields + a loader + a SENSITIVE_KEYS constant
      const cases = [
        {
          outputFile: 'env_types.py',
          markers: ['class Env(TypedDict):', 'DEBUG: NotRequired[bool]', 'DB_PORT: NotRequired[int]', 'PUBLIC_VAR: str', 'def load_env() -> Env:'],
          sensitiveMarker: 'SENSITIVE_KEYS: frozenset[str] = frozenset({"SECRET_TOKEN"})',
        },
        {
          outputFile: 'env_types.rs',
          markers: ['pub struct Env {', 'pub debug: Option<bool>,', 'pub db_port: Option<i64>,', 'pub fn load()'],
          sensitiveMarker: 'pub const SENSITIVE_KEYS: &[&str] = &["SECRET_TOKEN"];',
        },
        {
          // struct fields are gofmt-aligned (padded), so match name and type separately rather than
          // depending on the exact gap between them; `package env` comes from the `package=` override
          outputFile: 'env_types.go',
          markers: ['package env', 'type Env struct {', 'DbPort', '*int64', 'Debug', '*bool', 'func Load() (Env, error) {'],
          sensitiveMarker: 'var SensitiveKeys = map[string]bool{"SECRET_TOKEN": true}',
        },
        {
          outputFile: 'env_types.php',
          markers: ['final class Env', 'public readonly ?bool $DEBUG = null,', 'public readonly ?int $DB_PORT = null,', 'public static function load(): self'],
          sensitiveMarker: "public const SENSITIVE_KEYS = ['SECRET_TOKEN'];",
        },
      ] as const;

      for (const testCase of cases) {
        const polyglotOutputPath = join(polyglotDir, testCase.outputFile);
        if (existsSync(polyglotOutputPath)) rmSync(polyglotOutputPath);
      }

      const result = varlockCodegen({ cwd: 'smoke-test-typegen-polyglot' });
      expect(result.exitCode).toBe(0);

      for (const testCase of cases) {
        const polyglotOutputPath = join(polyglotDir, testCase.outputFile);
        expect(existsSync(polyglotOutputPath)).toBe(true);

        const src = readFileSync(polyglotOutputPath, 'utf-8');
        for (const marker of testCase.markers) {
          expect(src).toContain(marker);
        }
        // sensitivity is exposed as a constant listing the sensitive keys
        expect(src).toContain(testCase.sensitiveMarker);
      }
    });

    test('varlock codegen exposeEnv=local emits an importable ENV without global augmentation', () => {
      const moduleDir = join(SMOKE_TESTS_DIR, 'smoke-test-typegen-module');
      const outputPath = join(moduleDir, 'env.ts');
      if (existsSync(outputPath)) rmSync(outputPath);

      const result = varlockCodegen({ cwd: 'smoke-test-typegen-module' });
      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      const src = readFileSync(outputPath, 'utf-8');
      expect(src).toContain("import { ENV as _ENV } from 'varlock/env';");
      expect(src).toContain('export const ENV = _ENV as unknown as Readonly<CoercedEnvSchema>;');
      // module mode must NOT globally augment varlock/env — and the process.env / import.meta.env
      // augmentations default off too, so nothing from this package merges into the global scope
      expect(src).not.toContain("declare module 'varlock/env'");
      expect(src).not.toContain('declare global {');
    });

    test('varlock typegen still works as a deprecated alias for codegen', () => {
      if (existsSync(typeFilePath)) rmSync(typeFilePath);
      const result = runVarlock(['typegen'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('deprecated');
      expect(existsSync(typeFilePath)).toBe(true);
    });
  });

  describe('error output - schema errors', () => {
    test('exits non-zero on unknown root decorator', () => {
      const result = varlockLoad({ cwd: 'smoke-test-invalid' });
      expect(result.exitCode).not.toBe(0);
    });

    test('shows the unknown decorator error in output', () => {
      const result = varlockLoad({ cwd: 'smoke-test-invalid' });
      expect(result.output).toContain('Unknown decorator');
      expect(result.output).toContain('@badRootDecorator');
    });

    test('shows file path in error output', () => {
      const result = varlockLoad({ cwd: 'smoke-test-invalid' });
      expect(result.output).toContain('.env.schema');
    });

    test('--format json-full outputs JSON even on schema errors', () => {
      const result = varlockLoad({ cwd: 'smoke-test-invalid', format: 'json-full' });
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const parsed = JSON.parse(result.stdout);
      expect(parsed.errors).toBeDefined();
    });
  });

  describe('error output - validation errors', () => {
    test('exits non-zero on invalid config', () => {
      const result = varlockLoad({ cwd: 'smoke-test-invalid-items' });
      expect(result.exitCode).not.toBe(0);
    });

    test('shows invalid decorator name error', () => {
      const result = varlockLoad({ cwd: 'smoke-test-invalid-items' });
      expect(result.output).toContain('not a valid decorator name');
      expect(result.output).toContain('@sensitive,');
    });

    test('shows required value error', () => {
      const result = varlockLoad({ cwd: 'smoke-test-invalid-items' });
      expect(result.output).toContain('REQUIRED_MISSING');
      expect(result.output).toContain('required but is currently empty');
    });

    test('shows "Configuration is currently invalid" banner', () => {
      const result = varlockLoad({ cwd: 'smoke-test-invalid-items' });
      expect(result.output).toContain('Configuration is currently invalid');
    });
  });
});
