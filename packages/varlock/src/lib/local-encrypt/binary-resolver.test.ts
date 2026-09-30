import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import path from 'node:path';
import { getInstalledPlatformPackageName, getNativeBinarySpawnOptions, getPlatformPackageName } from './binary-resolver';
import { isWSL } from './wsl-detect';

vi.mock('./wsl-detect', () => ({ isWSL: vi.fn(() => false) }));

function withPlatform(platform: string, arch: string, fn: () => void) {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const origArch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', origPlatform);
    Object.defineProperty(process, 'arch', origArch);
  }
}

describe('getPlatformPackageName', () => {
  beforeEach(() => {
    vi.mocked(isWSL).mockReturnValue(false);
  });

  it('maps darwin (any arch) to the universal darwin package', () => {
    withPlatform('darwin', 'arm64', () => {
      expect(getPlatformPackageName()).toBe('@varlock/native-helper-darwin');
    });
    withPlatform('darwin', 'x64', () => {
      expect(getPlatformPackageName()).toBe('@varlock/native-helper-darwin');
    });
  });

  it('maps linux x64/arm64 to arch-specific packages', () => {
    withPlatform('linux', 'x64', () => {
      expect(getPlatformPackageName()).toBe('@varlock/native-helper-linux-x64');
    });
    withPlatform('linux', 'arm64', () => {
      expect(getPlatformPackageName()).toBe('@varlock/native-helper-linux-arm64');
    });
  });

  it('returns undefined for unsupported platforms/arches', () => {
    withPlatform('linux', 'riscv64', () => {
      expect(getPlatformPackageName()).toBeUndefined();
    });
    withPlatform('freebsd', 'x64', () => {
      expect(getPlatformPackageName()).toBeUndefined();
    });
    withPlatform('win32', 'arm64', () => {
      expect(getPlatformPackageName()).toBeUndefined();
    });
  });

  it('maps win32 x64 to the win32 package', () => {
    withPlatform('win32', 'x64', () => {
      expect(getPlatformPackageName()).toBe('@varlock/native-helper-win32-x64');
    });
  });

  it('maps WSL (any arch) to the win32 package for DPAPI/Hello via interop', () => {
    vi.mocked(isWSL).mockReturnValue(true);
    withPlatform('linux', 'x64', () => {
      expect(getPlatformPackageName()).toBe('@varlock/native-helper-win32-x64');
    });
    withPlatform('linux', 'arm64', () => {
      expect(getPlatformPackageName()).toBe('@varlock/native-helper-win32-x64');
    });
  });
});

describe('getInstalledPlatformPackageName', () => {
  it('does not report an optional dependency from a development checkout', () => {
    expect(getInstalledPlatformPackageName()).toBeUndefined();
  });
});

describe('getNativeBinarySpawnOptions', () => {
  const origXdg = process.env.XDG_CONFIG_HOME;
  const restoreXdg = () => {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  };

  it('starts the helper from its own directory', () => {
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(getNativeBinarySpawnOptions('/opt/varlock/varlock-local-encrypt')).toEqual({ cwd: '/opt/varlock' });
    } finally {
      restoreXdg();
    }
  });

  it('passes a relative XDG_CONFIG_HOME on resolved against the caller cwd', () => {
    process.env.XDG_CONFIG_HOME = 'rel-config';
    try {
      const { env } = getNativeBinarySpawnOptions('/opt/varlock/varlock-local-encrypt');
      expect(env?.XDG_CONFIG_HOME).toBe(path.resolve('rel-config'));
    } finally {
      restoreXdg();
    }
  });

  it('leaves an absolute XDG_CONFIG_HOME to the inherited env', () => {
    process.env.XDG_CONFIG_HOME = '/home/someone/.config';
    try {
      expect(getNativeBinarySpawnOptions('/opt/varlock/varlock-local-encrypt').env).toBeUndefined();
    } finally {
      restoreXdg();
    }
  });
});
