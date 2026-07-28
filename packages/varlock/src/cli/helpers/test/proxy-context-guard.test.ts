import {
  describe, expect, test,
} from 'vitest';

import { CliExitError } from '../exit-error';
import {
  enforceProxyContextGuards,
} from '../proxy-context-guard';

describe('enforceProxyContextGuards', () => {
  const proxiedEnv = { __VARLOCK_PROXY_CHILD: '1' } as NodeJS.ProcessEnv;
  const normalEnv = {} as NodeJS.ProcessEnv;

  test('does nothing outside proxied context', async () => {
    await expect(enforceProxyContextGuards(['reveal'], normalEnv)).resolves.toBeUndefined();
  });

  test('allows nested run in proxied context', async () => {
    await expect(enforceProxyContextGuards(['run', '--', 'echo', 'x'], proxiedEnv)).resolves.toBeUndefined();
  });

  test('allows printenv in proxied context', async () => {
    await expect(enforceProxyContextGuards(['printenv', 'API_KEY'], proxiedEnv)).resolves.toBeUndefined();
  });

  test('blocks reveal in proxied context', async () => {
    await expect(enforceProxyContextGuards(['reveal', 'API_KEY'], proxiedEnv)).rejects.toBeInstanceOf(CliExitError);
  });

  test('allows load commands in proxied context', async () => {
    await expect(enforceProxyContextGuards(['load'], proxiedEnv)).resolves.toBeUndefined();
    await expect(enforceProxyContextGuards(['load', '--format', 'pretty'], proxiedEnv)).resolves.toBeUndefined();
    await expect(enforceProxyContextGuards(['load', '--format', 'json', '--agent'], proxiedEnv)).resolves.toBeUndefined();
    await expect(enforceProxyContextGuards(['load', '--format', 'json'], proxiedEnv)).resolves.toBeUndefined();
    await expect(enforceProxyContextGuards(['load', '--format', 'shell'], proxiedEnv)).resolves.toBeUndefined();
    await expect(enforceProxyContextGuards(['load', '--format', 'env'], proxiedEnv)).resolves.toBeUndefined();
  });

  test('blocks nested proxy run/start in proxied context', async () => {
    await expect(enforceProxyContextGuards(['proxy', 'run', '--', 'claude'], proxiedEnv)).rejects.toBeInstanceOf(CliExitError);
    await expect(enforceProxyContextGuards(['proxy', 'start'], proxiedEnv)).rejects.toBeInstanceOf(CliExitError);
  });

  test('allows non-launch proxy commands in proxied context', async () => {
    await expect(enforceProxyContextGuards(['proxy', 'status'], proxiedEnv)).resolves.toBeUndefined();
    await expect(enforceProxyContextGuards(['proxy', 'env'], proxiedEnv)).resolves.toBeUndefined();
    await expect(enforceProxyContextGuards(['proxy', 'reload'], proxiedEnv)).resolves.toBeUndefined();
  });
});
