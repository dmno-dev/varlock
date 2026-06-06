import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  ENV,
  clearDynamicPublicEnv,
  getDynamicConfigKeys,
  getDynamicPublicConfigKeys,
  getDynamicPublicEnv,
  loadPublicDynamicEnv,
  getPublicDynamicEnv,
  initVarlockEnv,
  setDynamicPublicEnv,
} from '../env';

const DYNAMIC_KEY = 'PUBLIC_DYNAMIC_TEST';
const originalFetch = globalThis.fetch;

describe('dynamic public env hydration', () => {
  beforeEach(() => {
    (globalThis as any).__varlockThrowOnMissingKeys = true;
    (globalThis as any).__varlockExecutionPhase = undefined;
    (globalThis as any).__varlockDynamicBuildAccessMode = undefined;
    (globalThis as any).__varlockDynamicKeys = [DYNAMIC_KEY];
    (globalThis as any).__varlockDynamicPublicKeys = [DYNAMIC_KEY];
    (globalThis as any).__varlockOnDynamicConfigAccess = undefined;
    delete process.env._VARLOCK_EXECUTION_PHASE;
    delete process.env._VARLOCK_DYNAMIC_BUILD_ACCESS_MODE;
    clearDynamicPublicEnv([DYNAMIC_KEY]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('hydrates ENV values via setDynamicPublicEnv', () => {
    setDynamicPublicEnv({ [DYNAMIC_KEY]: 'hello-runtime' });
    expect((ENV as any)[DYNAMIC_KEY]).toBe('hello-runtime');
    expect((getDynamicPublicEnv() as any)[DYNAMIC_KEY]).toBe('hello-runtime');
    expect((getPublicDynamicEnv() as any)[DYNAMIC_KEY]).toBe('hello-runtime');
  });

  it('getPublicDynamicEnv accepts an optional key list', () => {
    (globalThis as any).__varlockDynamicPublicKeys = [
      'PUBLIC_DYNAMIC_TEST',
      'OTHER_PUBLIC_DYNAMIC',
    ];
    setDynamicPublicEnv({
      PUBLIC_DYNAMIC_TEST: 'a',
      OTHER_PUBLIC_DYNAMIC: 'b',
    });
    expect(getPublicDynamicEnv(['PUBLIC_DYNAMIC_TEST'])).toEqual({
      PUBLIC_DYNAMIC_TEST: 'a',
    });
  });

  it('getPublicDynamicEnv honors explicit keys when metadata is unavailable', () => {
    (globalThis as any).__varlockDynamicPublicKeys = undefined;
    setDynamicPublicEnv({
      PUBLIC_DYNAMIC_TEST: 'a',
      OTHER_PUBLIC_DYNAMIC: 'b',
    });
    expect(getPublicDynamicEnv(['PUBLIC_DYNAMIC_TEST'])).toEqual({
      PUBLIC_DYNAMIC_TEST: 'a',
    });
  });

  it('throws helpful guidance when dynamic+public key is accessed before hydration', () => {
    expect(() => (ENV as any)[DYNAMIC_KEY]).toThrow(/dynamic\+public and has not been hydrated yet/i);
  });

  it('notifies on dynamic key access when a runtime hook is installed', () => {
    const onAccess = vi.fn();
    (globalThis as any).__varlockOnDynamicConfigAccess = onAccess;
    setDynamicPublicEnv({ [DYNAMIC_KEY]: 'hello-runtime' });
    expect((ENV as any)[DYNAMIC_KEY]).toBe('hello-runtime');
    expect(onAccess).toHaveBeenCalledWith({
      key: DYNAMIC_KEY,
      isPublic: true,
    });
  });

  it('exposes dynamic metadata from initVarlockEnv', () => {
    process.env.__VARLOCK_ENV = JSON.stringify({
      sources: [],
      settings: {},
      config: {
        PUBLIC_STATIC_TEST: { value: 'a', isSensitive: false, isDynamic: false },
        PUBLIC_DYNAMIC_TEST: { value: 'b', isSensitive: false, isDynamic: true },
        SECRET_DYNAMIC_TEST: { value: 'c', isSensitive: true, isDynamic: true },
      },
    });

    initVarlockEnv();

    expect(getDynamicConfigKeys()).toEqual(expect.arrayContaining([
      'PUBLIC_DYNAMIC_TEST',
      'SECRET_DYNAMIC_TEST',
    ]));
    expect(getDynamicPublicConfigKeys()).toEqual(['PUBLIC_DYNAMIC_TEST']);
  });

  it('throws when a dynamic key is accessed during build/prerender phase', () => {
    (globalThis as any).__varlockDynamicKeys = [DYNAMIC_KEY];
    (globalThis as any).__varlockExecutionPhase = 'build';
    setDynamicPublicEnv({ [DYNAMIC_KEY]: 'hello-runtime' });
    expect(() => (ENV as any)[DYNAMIC_KEY]).toThrow(/accessed during build/i);
  });

  it('supports _VARLOCK_EXECUTION_PHASE and _VARLOCK_DYNAMIC_BUILD_ACCESS_MODE', () => {
    (globalThis as any).__varlockExecutionPhase = undefined;
    (globalThis as any).__varlockDynamicBuildAccessMode = undefined;
    process.env._VARLOCK_EXECUTION_PHASE = 'build';
    process.env._VARLOCK_DYNAMIC_BUILD_ACCESS_MODE = 'warn';
    setDynamicPublicEnv({ [DYNAMIC_KEY]: 'hello-runtime' });
    expect(() => (ENV as any)[DYNAMIC_KEY]).not.toThrow();
  });

  it('loadPublicDynamicEnv fetches and hydrates ENV values', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ [DYNAMIC_KEY]: 'loaded-from-endpoint' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const payload = await loadPublicDynamicEnv();

    expect(fetchCount).toBe(1);
    expect(payload).toEqual({ [DYNAMIC_KEY]: 'loaded-from-endpoint' });
    expect((ENV as any)[DYNAMIC_KEY]).toBe('loaded-from-endpoint');
  });

  it('loadPublicDynamicEnv avoids refetch when already hydrated', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ [DYNAMIC_KEY]: 'loaded-once' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await loadPublicDynamicEnv();
    const second = await loadPublicDynamicEnv();

    expect(fetchCount).toBe(1);
    expect(second).toEqual({ [DYNAMIC_KEY]: 'loaded-once' });
  });

  it('loadPublicDynamicEnv dedupes concurrent fetches', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      return new Response(JSON.stringify({ [DYNAMIC_KEY]: 'loaded-concurrent' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const [a, b] = await Promise.all([
      loadPublicDynamicEnv(),
      loadPublicDynamicEnv(),
    ]);

    expect(fetchCount).toBe(1);
    expect(a).toEqual({ [DYNAMIC_KEY]: 'loaded-concurrent' });
    expect(b).toEqual({ [DYNAMIC_KEY]: 'loaded-concurrent' });
  });
});
