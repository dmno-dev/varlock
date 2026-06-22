import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

vi.mock('../js-package-manager-utils', () => ({
  detectJsPackageManager: vi.fn(),
}));

import { detectJsPackageManager } from '../js-package-manager-utils';
import { getJsPackageManagerForTelemetry } from '../telemetry';

describe('getJsPackageManagerForTelemetry', () => {
  beforeEach(() => {
    vi.mocked(detectJsPackageManager).mockReset();
  });

  it('returns the detected package manager name', () => {
    vi.mocked(detectJsPackageManager).mockReturnValue({
      name: 'pnpm',
      lockfiles: ['pnpm-lock.yaml'],
      add: 'pnpm add',
      exec: 'pnpm exec',
      dlx: 'pnpm dlx',
    });

    expect(getJsPackageManagerForTelemetry()).toBe('pnpm');
  });

  it('returns null when no package manager is detected', () => {
    vi.mocked(detectJsPackageManager).mockReturnValue(undefined);
    expect(getJsPackageManagerForTelemetry()).toBeNull();
  });
});
