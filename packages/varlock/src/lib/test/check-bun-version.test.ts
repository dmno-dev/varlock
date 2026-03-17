import {
  describe, it, expect,
} from 'vitest';
import { checkBunVersion, MIN_BUN_VERSION } from '../check-bun-version';

describe('checkBunVersion', () => {
  function withBunVersion(version: string | undefined, fn: () => void) {
    const originalVersions = process.versions;
    Object.defineProperty(process, 'versions', {
      value: { ...originalVersions, bun: version },
      configurable: true,
      writable: true,
    });
    try {
      fn();
    } finally {
      Object.defineProperty(process, 'versions', {
        value: originalVersions,
        configurable: true,
        writable: true,
      });
    }
  }

  it('should not throw when not running under Bun', () => {
    withBunVersion(undefined, () => {
      expect(() => checkBunVersion()).not.toThrow();
    });
  });

  it('should not throw when running on the minimum supported Bun version', () => {
    withBunVersion(MIN_BUN_VERSION, () => {
      expect(() => checkBunVersion()).not.toThrow();
    });
  });

  it('should not throw when running on a newer Bun version', () => {
    withBunVersion('2.0.0', () => {
      expect(() => checkBunVersion()).not.toThrow();
    });
  });

  it('should throw when running on an older Bun version', () => {
    withBunVersion('1.3.2', () => {
      expect(() => checkBunVersion()).toThrow(/Bun >= 1\.3\.3/);
    });
  });

  it('should include the current Bun version in the error message', () => {
    withBunVersion('1.0.0', () => {
      expect(() => checkBunVersion()).toThrow(/Bun 1\.0\.0/);
    });
  });

  it('should include upgrade instructions in the error message', () => {
    withBunVersion('1.2.0', () => {
      expect(() => checkBunVersion()).toThrow(/bun upgrade/);
    });
  });
});
