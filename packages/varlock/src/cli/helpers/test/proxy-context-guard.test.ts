import {
  describe, expect, test, vi, beforeEach,
} from 'vitest';

const {
  loadVarlockEnvGraphMock,
  buildProxySchemaFingerprintMock,
} = vi.hoisted(() => ({
  loadVarlockEnvGraphMock: vi.fn(),
  buildProxySchemaFingerprintMock: vi.fn(),
}));

vi.mock('../../../lib/load-graph', () => ({
  loadVarlockEnvGraph: loadVarlockEnvGraphMock,
}));

vi.mock('../proxy-schema-fingerprint', () => ({
  buildProxySchemaFingerprint: buildProxySchemaFingerprintMock,
}));

import { CliExitError } from '../exit-error';
import {
  enforceProxyContextGuards,
  parseLoadSafetyArgs,
  PROXY_SCHEMA_FINGERPRINT_ENV_VAR,
} from '../proxy-context-guard';

describe('parseLoadSafetyArgs', () => {
  test('defaults to pretty and agent=false', () => {
    expect(parseLoadSafetyArgs([])).toEqual({ format: 'pretty', agent: false });
  });

  test('parses --format json with --agent', () => {
    expect(parseLoadSafetyArgs(['--format', 'json', '--agent'])).toEqual({
      format: 'json',
      agent: true,
    });
  });

  test('parses inline --format=json-full', () => {
    expect(parseLoadSafetyArgs(['--format=json-full'])).toEqual({
      format: 'json-full',
      agent: false,
    });
  });

  test('parses short -f shell', () => {
    expect(parseLoadSafetyArgs(['-f', 'shell'])).toEqual({
      format: 'shell',
      agent: false,
    });
  });

  test('parses --path and --env for schema verification', () => {
    expect(parseLoadSafetyArgs(['--path', './config/.env.schema', '--env', 'production'])).toEqual({
      format: 'pretty',
      agent: false,
      env: 'production',
      paths: ['./config/.env.schema'],
    });
  });
});

describe('enforceProxyContextGuards', () => {
  const proxiedEnv = { __VARLOCK_PROXY_CHILD: '1' } as NodeJS.ProcessEnv;
  const normalEnv = {} as NodeJS.ProcessEnv;

  beforeEach(() => {
    loadVarlockEnvGraphMock.mockReset();
    buildProxySchemaFingerprintMock.mockReset();
    loadVarlockEnvGraphMock.mockResolvedValue({});
    buildProxySchemaFingerprintMock.mockReturnValue('approved-fingerprint');
  });

  test('does nothing outside proxied context', async () => {
    await expect(enforceProxyContextGuards(['reveal'], normalEnv)).resolves.toBeUndefined();
  });

  test('blocks nested run in proxied context', async () => {
    await expect(enforceProxyContextGuards(['run', '--', 'echo', 'x'], proxiedEnv)).rejects.toBeInstanceOf(CliExitError);
  });

  test('blocks printenv in proxied context', async () => {
    await expect(enforceProxyContextGuards(['printenv', 'API_KEY'], proxiedEnv)).rejects.toBeInstanceOf(CliExitError);
  });

  test('blocks reveal in proxied context', async () => {
    await expect(enforceProxyContextGuards(['reveal', 'API_KEY'], proxiedEnv)).rejects.toBeInstanceOf(CliExitError);
  });

  test('allows load pretty in proxied context', async () => {
    await expect(enforceProxyContextGuards(['load'], proxiedEnv)).resolves.toBeUndefined();
    await expect(enforceProxyContextGuards(['load', '--format', 'pretty'], proxiedEnv)).resolves.toBeUndefined();
  });

  test('blocks load json without --agent in proxied context', async () => {
    await expect(enforceProxyContextGuards(['load', '--format', 'json'], proxiedEnv)).rejects.toBeInstanceOf(CliExitError);
  });

  test('allows load json with --agent in proxied context', async () => {
    await expect(enforceProxyContextGuards(['load', '--format', 'json', '--agent'], proxiedEnv)).resolves.toBeUndefined();
  });

  test('blocks load shell/env in proxied context', async () => {
    await expect(enforceProxyContextGuards(['load', '--format', 'shell'], proxiedEnv)).rejects.toBeInstanceOf(CliExitError);
    await expect(enforceProxyContextGuards(['load', '--format', 'env'], proxiedEnv)).rejects.toBeInstanceOf(CliExitError);
  });

  test('blocks load when schema fingerprint no longer matches approved snapshot', async () => {
    const envWithFingerprint = {
      ...proxiedEnv,
      [PROXY_SCHEMA_FINGERPRINT_ENV_VAR]: 'approved-fingerprint',
    } as NodeJS.ProcessEnv;

    buildProxySchemaFingerprintMock.mockReturnValue('different-fingerprint');

    await expect(enforceProxyContextGuards(['load'], envWithFingerprint)).rejects.toBeInstanceOf(CliExitError);
  });

  test('allows load when schema fingerprint matches approved snapshot', async () => {
    const envWithFingerprint = {
      ...proxiedEnv,
      [PROXY_SCHEMA_FINGERPRINT_ENV_VAR]: 'approved-fingerprint',
    } as NodeJS.ProcessEnv;

    buildProxySchemaFingerprintMock.mockReturnValue('approved-fingerprint');

    await expect(enforceProxyContextGuards(['load'], envWithFingerprint)).resolves.toBeUndefined();
  });
});
