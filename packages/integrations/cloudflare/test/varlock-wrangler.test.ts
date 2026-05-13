import {
  chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  afterEach, describe, expect, it,
} from 'vitest';

const cliPath = join(import.meta.dirname, '../src/varlock-wrangler.ts');

function setupProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'varlock-wrangler-test-'));
  const fakeWranglerPath = join(projectDir, 'wrangler');
  const argsOutPath = join(projectDir, 'wrangler-args.txt');

  writeFileSync(join(projectDir, '.env.schema'), [
    '# @defaultSensitive=false @defaultRequired=infer',
    '# @currentEnv=$APP_ENV',
    '# ---',
    '',
    '# @type=enum(dev)',
    'APP_ENV=dev',
    '',
    'PUBLIC_VAR=public-test-value',
    '',
    '# @sensitive',
    'SECRET_KEY=super-secret-value',
    '',
  ].join('\n'));
  writeFileSync(join(projectDir, '.env.dev'), '');
  writeFileSync(fakeWranglerPath, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$FAKE_WRANGLER_ARGS_FILE"\n');
  chmodSync(fakeWranglerPath, 0o755);

  return {
    projectDir,
    argsOutPath,
  };
}

function runVarlockWrangler(args: Array<string>) {
  const ctx = setupProject();
  const result = spawnSync('bun', ['run', cliPath, ...args], {
    cwd: ctx.projectDir,
    env: {
      ...process.env,
      PATH: `${ctx.projectDir}:${process.env.PATH ?? ''}`,
      FAKE_WRANGLER_ARGS_FILE: ctx.argsOutPath,
    },
  });

  return {
    ...ctx,
    result,
    wranglerArgs: readFileSync(ctx.argsOutPath, 'utf8').trim().split('\n').filter(Boolean),
  };
}

const cleanupDirs: Array<string> = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('varlock-wrangler wrangler flag handling', () => {
  it('does not pass --keep-vars=false for versions upload', () => {
    const run = runVarlockWrangler(['versions', 'upload']);
    cleanupDirs.push(run.projectDir);

    expect(run.result.status).toBe(0);
    expect(run.wranglerArgs).not.toContain('--keep-vars=false');
  });

  it('passes --keep-vars=false for deploy', () => {
    const run = runVarlockWrangler(['deploy']);
    cleanupDirs.push(run.projectDir);

    expect(run.result.status).toBe(0);
    expect(run.wranglerArgs).toContain('--keep-vars=false');
  });
});
