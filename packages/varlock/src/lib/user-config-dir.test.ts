import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getUserVarlockDir } from './user-config-dir';

describe('getUserVarlockDir', () => {
  it('returns an absolute path for a relative XDG_CONFIG_HOME', () => {
    const orig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = 'rel-config';
    try {
      expect(getUserVarlockDir()).toBe(path.resolve('rel-config', 'varlock'));
    } finally {
      if (orig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = orig;
    }
  });
});
