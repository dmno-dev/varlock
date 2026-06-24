import { describe, expect, test } from 'vitest';

import { isWellKnownEnvKey } from '../well-known-env-keys';

describe('isWellKnownEnvKey', () => {
  test('matches OS/shell, runtime, and CI vars', () => {
    for (const key of ['PATH', 'HOME', 'NODE_ENV', 'CI', 'GITHUB_ACTIONS', 'GITHUB_BASE_REF', 'VERCEL', 'XDG_CONFIG_HOME']) {
      expect(isWellKnownEnvKey(key)).toBe(true);
    }
  });

  test('matches case-insensitively (e.g. Windows ComSpec)', () => {
    expect(isWellKnownEnvKey('comspec')).toBe(true);
    expect(isWellKnownEnvKey('ComSpec')).toBe(true);
  });

  test('matches npm_ prefixed lifecycle vars', () => {
    expect(isWellKnownEnvKey('npm_config_user_agent')).toBe(true);
    expect(isWellKnownEnvKey('npm_lifecycle_event')).toBe(true);
    expect(isWellKnownEnvKey('npm_package_name')).toBe(true);
  });

  test('does NOT match application config or secrets', () => {
    for (const key of ['PORT', 'HOST', 'DATABASE_URL', 'API_KEY', 'GITHUB_TOKEN', 'STRIPE_SECRET', 'MY_APP_URL']) {
      expect(isWellKnownEnvKey(key)).toBe(false);
    }
  });
});
