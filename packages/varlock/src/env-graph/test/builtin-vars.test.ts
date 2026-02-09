import { describe, test } from 'vitest';
import { envFilesTest } from './helpers/generic-test';

describe('VARLOCK_* builtin variables', () => {
  describe('lazy registration', () => {
    test('builtin vars are not in schema unless referenced', envFilesTest({
      envFile: 'OTHER_VAR=foo',
      expectValues: { OTHER_VAR: 'foo' },
      expectNotInSchema: ['VARLOCK_ENV', 'VARLOCK_IS_CI'],
    }));

    test('builtin vars are registered when referenced via $VARLOCK_*', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV\nIS_CI=$VARLOCK_IS_CI',
      processEnv: {},
      expectValues: {
        VARLOCK_ENV: 'development',
        VARLOCK_IS_CI: 'false',
      },
      expectSensitive: {
        VARLOCK_ENV: false,
        VARLOCK_IS_CI: false,
      },
      expectRequired: {
        VARLOCK_ENV: false,
        VARLOCK_IS_CI: false,
      },
    }));
  });

  describe('VARLOCK_ENV environment detection', () => {
    test('detects test environment from NODE_ENV=test', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: { NODE_ENV: 'test' },
      expectValues: { VARLOCK_ENV: 'test' },
    }));

    test('detects test environment from VITEST', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: { VITEST: 'true' },
      expectValues: { VARLOCK_ENV: 'test' },
    }));

    test('detects test environment from JEST_WORKER_ID', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: { JEST_WORKER_ID: '1' },
      expectValues: { VARLOCK_ENV: 'test' },
    }));

    test('detects development when not in CI', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: {},
      expectValues: { VARLOCK_ENV: 'development' },
    }));

    test('infers production from main branch', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      expectValues: { VARLOCK_ENV: 'production' },
    }));

    test('infers production from master branch', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/master',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      expectValues: { VARLOCK_ENV: 'production' },
    }));

    test('infers staging from develop branch', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/develop',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      expectValues: { VARLOCK_ENV: 'staging' },
    }));

    test('infers preview from feature branch', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/feature/my-feature',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      expectValues: { VARLOCK_ENV: 'preview' },
    }));

    test('uses platform-provided environment (Vercel)', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: {
        VERCEL: '1',
        VERCEL_ENV: 'production',
      },
      expectValues: { VARLOCK_ENV: 'production' },
    }));

    test('defaults to preview when in CI but unknown branch', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: { CI: 'true' },
      expectValues: { VARLOCK_ENV: 'preview' },
    }));

    test('test detection takes priority over platform env', envFilesTest({
      envFile: 'MY_ENV=$VARLOCK_ENV',
      processEnv: {
        NODE_ENV: 'test',
        VERCEL: '1',
        VERCEL_ENV: 'production',
      },
      expectValues: { VARLOCK_ENV: 'test' },
    }));
  });

  describe('VARLOCK_IS_CI', () => {
    test('returns "false" when not in CI', envFilesTest({
      envFile: 'MY_VAR=$VARLOCK_IS_CI',
      processEnv: {},
      expectValues: { VARLOCK_IS_CI: 'false' },
    }));

    test('returns "true" when in CI', envFilesTest({
      envFile: 'MY_VAR=$VARLOCK_IS_CI',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      expectValues: { VARLOCK_IS_CI: 'true' },
    }));
  });

  describe('CI platform variables', () => {
    test('VARLOCK_BRANCH returns branch name', envFilesTest({
      envFile: 'MY_VAR=$VARLOCK_BRANCH',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/feature-branch',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      expectValues: { VARLOCK_BRANCH: 'feature-branch' },
    }));

    test('VARLOCK_COMMIT_SHA and VARLOCK_COMMIT_SHA_SHORT', envFilesTest({
      envFile: 'SHA=$VARLOCK_COMMIT_SHA\nSHA_SHORT=$VARLOCK_COMMIT_SHA_SHORT',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: 'abc1234567890def1234567890abcdef12345678',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      expectValues: {
        VARLOCK_COMMIT_SHA: 'abc1234567890def1234567890abcdef12345678',
        VARLOCK_COMMIT_SHA_SHORT: 'abc1234',
      },
    }));

    test('VARLOCK_PLATFORM returns CI platform name', envFilesTest({
      envFile: 'MY_VAR=$VARLOCK_PLATFORM',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      expectValues: { VARLOCK_PLATFORM: 'GitHub Actions' },
    }));

    test('VARLOCK_REPO returns owner/repo format', envFilesTest({
      envFile: 'MY_VAR=$VARLOCK_REPO',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'my-org/my-repo',
      },
      expectValues: { VARLOCK_REPO: 'my-org/my-repo' },
    }));
  });

  describe('builtin vars in string interpolation', () => {
    test('can use VARLOCK_* in concat expressions', envFilesTest({
      envFile: 'DEBUG_INFO="SHA: $VARLOCK_COMMIT_SHA_SHORT"',
      processEnv: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: 'abc1234567890',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      expectValues: { DEBUG_INFO: 'SHA: abc1234' },
    }));
  });

  describe('@currentEnv=$VARLOCK_ENV', () => {
    test('VARLOCK_ENV works with @currentEnv and env-specific files', envFilesTest({
      files: {
        '.env.schema': '# @currentEnv=$VARLOCK_ENV\n# ---\nITEM1=default-value',
        '.env.test': 'ITEM1=test-value',
        '.env.development': 'ITEM1=dev-value',
      },
      processEnv: { NODE_ENV: 'test' },
      expectValues: {
        VARLOCK_ENV: 'test',
        ITEM1: 'test-value',
      },
    }));

    test('VARLOCK_ENV works with @currentEnv for development', envFilesTest({
      files: {
        '.env.schema': '# @currentEnv=$VARLOCK_ENV\n# ---\nITEM1=default-value',
        '.env.development': 'ITEM1=dev-value',
      },
      processEnv: {},
      expectValues: {
        VARLOCK_ENV: 'development',
        ITEM1: 'dev-value',
      },
    }));
  });
});
