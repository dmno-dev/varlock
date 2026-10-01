import { getOidcToken } from '@env-spec/utils/oidc-tokens';
import {
  beforeEach, describe, expect, test, vi,
} from 'vitest';

import { createSubjectTokenSupplier } from '../src/workload-identity';

vi.mock('@env-spec/utils/oidc-tokens', () => ({
  getOidcToken: vi.fn(),
}));

const getOidcTokenMock = vi.mocked(getOidcToken);

describe('Workload Identity subject token supplier', () => {
  beforeEach(() => {
    getOidcTokenMock.mockReset();
  });

  test('fetches a fresh auto-detected token for every request', async () => {
    getOidcTokenMock
      .mockResolvedValueOnce({ token: 'first-token', platform: 'vercel' })
      .mockResolvedValueOnce({ token: 'second-token', platform: 'vercel' });
    const supplier = createSubjectTokenSupplier('test-audience');

    await expect(supplier.getSubjectToken()).resolves.toBe('first-token');
    await expect(supplier.getSubjectToken()).resolves.toBe('second-token');
    expect(getOidcTokenMock).toHaveBeenCalledTimes(2);
    expect(getOidcTokenMock).toHaveBeenNthCalledWith(1, 'test-audience');
    expect(getOidcTokenMock).toHaveBeenNthCalledWith(2, 'test-audience');
  });

  test('reuses an explicitly supplied token', async () => {
    const supplier = createSubjectTokenSupplier('test-audience', 'explicit-token');

    await expect(supplier.getSubjectToken()).resolves.toBe('explicit-token');
    await expect(supplier.getSubjectToken()).resolves.toBe('explicit-token');
    expect(getOidcTokenMock).not.toHaveBeenCalled();
  });

  test('reports when no auto-detected token is available', async () => {
    getOidcTokenMock.mockResolvedValue(undefined);
    const supplier = createSubjectTokenSupplier('test-audience');

    await expect(supplier.getSubjectToken()).rejects.toThrow(
      'Unable to obtain an OIDC token for Google Workload Identity Federation',
    );
  });
});
