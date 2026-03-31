import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FrameworkTestEnv } from '../../harness/index';

const env = new FrameworkTestEnv({
  testDir: import.meta.dirname,
  framework: 'vanilla-node',
  packageManager: 'pnpm',
  dependencies: {
    varlock: 'will-be-replaced',
  },
});

const baseEnv = {
  ...process.env,
  COREPACK_ENABLE_STRICT: '0',
  COREPACK_ENABLE_PROJECT_SPEC: '0',
};

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  output: string;
}

function run(cmd: string, args: Array<string>): RunResult {
  const result = spawnSync(cmd, args, {
    cwd: env.dir,
    encoding: 'utf-8',
    timeout: 30_000,
    env: baseEnv,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

/** Run a node script inside the test project via `varlock run` */
function varlockRunNode(script: string) {
  return run('pnpm', ['exec', 'varlock', 'run', '--', 'node', script]);
}

/** Run a node script directly (without varlock run) */
function runNode(script: string) {
  return run('node', [script]);
}

describe('Vanilla Node.js', () => {
  beforeAll(() => env.setup(), 180_000);
  afterAll(() => env.teardown());

  describe('env var loading via varlock run', () => {
    test('vars are loaded into process.env and ENV proxy', () => {
      const { status, output } = varlockRunNode('check-env.mjs');
      expect(status).toBe(0);
      expect(output).toContain('process-env-ok');
      expect(output).toContain('env-proxy-ok');
      expect(output).toContain('public::hello-world');
      expect(output).toContain('api::https://api.example.com');
      expect(output).toContain('has-secret::yes');
    });

    test('vars are injected into process.env without importing varlock', () => {
      const { status, output } = varlockRunNode('check-process-env-only.mjs');
      expect(status).toBe(0);
      expect(output).toContain('process-env-only-ok');
      expect(output).toContain('public::hello-world');
      expect(output).toContain('api::https://api.example.com');
      expect(output).toContain('has-secret::yes');
    });
  });

  describe('varlock/auto-load', () => {
    test('loads env vars and enables console redaction', () => {
      const { status, output } = runNode('auto-load-check.mjs');
      expect(status).toBe(0);
      expect(output).toContain('auto-load-ok');
      // auto-load enables console redaction, so the secret should be redacted
      expect(output).not.toContain('super-secret-token-12345');
    });
  });

  describe('varlock/config (dotenv drop-in)', () => {
    test('loads env vars into process.env', () => {
      const { status, output } = runNode('dotenv-dropin.mjs');
      expect(status).toBe(0);
      expect(output).toContain('dotenv-dropin-ok');
      expect(output).toContain('public::hello-world');
      expect(output).toContain('has-secret::yes');
    });

    test('with a bad schema, does not cause a JSON parse error', () => {
      const schemaPath = join(env.dir, '.env.schema');
      const validSchema = readFileSync(schemaPath, 'utf-8');

      // Swap in the bad schema temporarily
      writeFileSync(schemaPath, [
        '# @defaultSensitive=false',
        '# ---',
        'PUBLIC_VAR=hello-world',
        '',
        '# @required',
        'MISSING_REQUIRED=',
      ].join('\n'));

      try {
        const {
          status, stdout, stderr, output,
        } = runNode('dotenv-dropin.mjs');
        expect(status).not.toBe(0);

        // The failure must NOT be a JSON parse error
        expect(output).not.toMatch(/JSON [Pp]arse [Ee]rror/);
        expect(output).not.toMatch(/Unrecognized token/);
        expect(output).not.toMatch(/SyntaxError.*JSON/);

        // Error diagnostics must only appear on stderr, not stdout
        expect(stdout).not.toContain('🚨');
        expect(stderr).toContain('🚨');
      } finally {
        // Restore valid schema
        writeFileSync(schemaPath, validSchema);
      }
    });
  });

  describe('console redaction', () => {
    test('sensitive values are redacted in varlock run output', () => {
      const { status, output } = varlockRunNode('check-redaction.mjs');
      expect(status).toBe(0);
      expect(output).toContain('redaction-test-done');
      expect(output).toContain('public:: hello-world');
      expect(output).not.toContain('super-secret-token-12345');
    });
  });

  describe('leak prevention', () => {
    // leaky-server.mjs imports varlock/auto-load which patches ServerResponse
    test('safe endpoint serves public values', () => {
      const { output } = runNode('leaky-server.mjs');
      expect(output).toContain('safe-status::200');
      expect(output).toContain('safe-body::public::hello-world');
    });

    test('leaky endpoint triggers leak detection', () => {
      const { output } = runNode('leaky-server.mjs');
      expect(output).toContain('DETECTED LEAKED SENSITIVE CONFIG');
      expect(output).not.toContain('super-secret-token-12345');
    });
  });
});
