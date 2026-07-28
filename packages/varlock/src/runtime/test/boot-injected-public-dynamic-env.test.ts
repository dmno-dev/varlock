import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

// force the runtime into its browser code path
vi.mock('../../lib/detect-runtime', () => ({ isBrowser: true }));

/**
 * Boot-time injection: a server or container entrypoint writes a
 * `<script>globalThis.__varlockPublicDynamicEnv = {...}</script>` tag into the served
 * HTML (e.g. from `varlock load --filter '@dynamic,!@sensitive' --format json`), and the
 * browser runtime hydrates from it at init - no endpoint fetch needed.
 */
describe('boot-time injected public dynamic env (browser)', () => {
  beforeEach(() => {
    vi.resetModules();
    // fresh shared env state per test (it lives on globalThis)
    delete (globalThis as any).__varlockEnvState;
    delete (globalThis as any).__varlockPublicDynamicEnv;
    delete (globalThis as any).__varlockThrowOnMissingKeys;
    delete process.env.__VARLOCK_ENV;
  });

  it('hydrates ENV from globalThis.__varlockPublicDynamicEnv at init', async () => {
    (globalThis as any).__varlockPublicDynamicKeys = ['PUBLIC_BOOT_FLAG'];
    (globalThis as any).__varlockPublicDynamicEnv = { PUBLIC_BOOT_FLAG: 'boot-injected' };

    const { ENV, loadPublicDynamicEnv } = await import('../env');

    expect((ENV as any).PUBLIC_BOOT_FLAG).toBe('boot-injected');

    // already hydrated, so this must short-circuit without any fetch
    const payload = await loadPublicDynamicEnv();
    expect((payload as any).PUBLIC_BOOT_FLAG).toBe('boot-injected');
  });

  it('ignores undeclared keys in the injected payload', async () => {
    (globalThis as any).__varlockPublicDynamicKeys = ['PUBLIC_BOOT_FLAG'];
    (globalThis as any).__varlockPublicDynamicEnv = {
      PUBLIC_BOOT_FLAG: 'boot-injected',
      NOT_DECLARED: 'nope',
    };

    const { ENV } = await import('../env');

    expect((ENV as any).PUBLIC_BOOT_FLAG).toBe('boot-injected');
    expect((ENV as any).NOT_DECLARED).toBeUndefined();
  });

  it('does nothing when the global is absent', async () => {
    (globalThis as any).__varlockPublicDynamicKeys = ['PUBLIC_BOOT_FLAG'];

    const { ENV } = await import('../env');
    expect((ENV as any).PUBLIC_BOOT_FLAG).toBeUndefined();
  });
});
