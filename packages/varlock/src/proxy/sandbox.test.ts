import { describe, expect, test } from 'vitest';

import { parseSandboxSpec, isContainerKind, checkSandboxAvailable } from './sandbox';

describe('parseSandboxSpec', () => {
  test('absent flag → undefined', () => {
    expect(parseSandboxSpec(undefined)).toBeUndefined();
  });

  test('bare --sandbox (empty / builtin / auto) → builtin', () => {
    expect(parseSandboxSpec('')).toEqual({ kind: 'builtin' });
    expect(parseSandboxSpec('builtin')).toEqual({ kind: 'builtin' });
    expect(parseSandboxSpec('auto')).toEqual({ kind: 'builtin' });
  });

  test('container runtimes are recognized, case-insensitively', () => {
    expect(parseSandboxSpec('docker')).toEqual({ kind: 'docker' });
    expect(parseSandboxSpec('Podman')).toEqual({ kind: 'podman' });
  });

  test('unknown value throws with guidance', () => {
    expect(() => parseSandboxSpec('vm')).toThrow(/Unknown --sandbox value "vm"/);
  });
});

describe('isContainerKind', () => {
  test('distinguishes container runtimes from the built-in', () => {
    expect(isContainerKind('docker')).toBe(true);
    expect(isContainerKind('podman')).toBe(true);
    expect(isContainerKind('builtin')).toBe(false);
  });
});

describe('checkSandboxAvailable (builtin)', () => {
  test('builtin availability follows the platform', () => {
    const result = checkSandboxAvailable({ kind: 'builtin' });
    if (process.platform === 'darwin') {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/only available on macOS/);
    }
  });
});
