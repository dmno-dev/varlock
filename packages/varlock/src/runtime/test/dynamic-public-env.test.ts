import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  ENV,
  clearPublicDynamicEnv,
  getDynamicConfigKeys,
  getPublicDynamicConfigKeys,
  loadPublicDynamicEnv,
  getPublicDynamicEnv,
  initVarlockEnv,
  setPublicDynamicEnv,
} from '../env';

const DYNAMIC_KEY = 'PUBLIC_DYNAMIC_TEST';
const originalFetch = globalThis.fetch;

describe('public dynamic env hydration', () => {
  beforeEach(() => {
    (globalThis as any).__varlockThrowOnMissingKeys = true;
    (globalThis as any).__varlockDynamicKeys = [DYNAMIC_KEY];
    (globalThis as any).__varlockPublicDynamicKeys = [DYNAMIC_KEY];
    (globalThis as any).__varlockOnDynamicConfigAccess = undefined;
    delete process.env.__VARLOCK_EXECUTION_PHASE;
    delete process.env._VARLOCK_DYNAMIC_BUILD_ACCESS_MODE;
    clearPublicDynamicEnv([DYNAMIC_KEY]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('hydrates ENV values via setPublicDynamicEnv', () => {
    setPublicDynamicEnv({ [DYNAMIC_KEY]: 'hello-runtime' });
    expect((ENV as any)[DYNAMIC_KEY]).toBe('hello-runtime');
    expect((getPublicDynamicEnv() as any)[DYNAMIC_KEY]).toBe('hello-runtime');
  });

  it('getPublicDynamicEnv accepts an optional key list', () => {
    (globalThis as any).__varlockPublicDynamicKeys = [
      'PUBLIC_DYNAMIC_TEST',
      'OTHER_PUBLIC_DYNAMIC',
    ];
    setPublicDynamicEnv({
      PUBLIC_DYNAMIC_TEST: 'a',
      OTHER_PUBLIC_DYNAMIC: 'b',
    });
    expect(getPublicDynamicEnv(['PUBLIC_DYNAMIC_TEST'])).toEqual({
      PUBLIC_DYNAMIC_TEST: 'a',
    });
  });

  it('getPublicDynamicEnv honors explicit keys when metadata is unavailable', () => {
    (globalThis as any).__varlockPublicDynamicKeys = undefined;
    setPublicDynamicEnv({
      PUBLIC_DYNAMIC_TEST: 'a',
      OTHER_PUBLIC_DYNAMIC: 'b',
    });
    expect(getPublicDynamicEnv(['PUBLIC_DYNAMIC_TEST'])).toEqual({
      PUBLIC_DYNAMIC_TEST: 'a',
    });
  });

  it('setPublicDynamicEnv ignores undeclared keys when the declared list is known', () => {
    setPublicDynamicEnv({
      [DYNAMIC_KEY]: 'hello-runtime',
      NOT_A_DECLARED_KEY: 'malicious',
    });
    expect((ENV as any)[DYNAMIC_KEY]).toBe('hello-runtime');
    expect(() => (ENV as any).NOT_A_DECLARED_KEY).toThrow(/does not exist/i);
  });

  it('throws helpful guidance when public+dynamic key is accessed before hydration', () => {
    expect(() => (ENV as any)[DYNAMIC_KEY]).toThrow(/public\+dynamic and has not been hydrated yet/i);
  });

  it('hydration guidance works when only the public key list is present (browser case)', () => {
    (globalThis as any).__varlockDynamicKeys = undefined;
    expect(() => (ENV as any)[DYNAMIC_KEY]).toThrow(/public\+dynamic and has not been hydrated yet/i);
  });

  it('notifies on dynamic key access when a runtime hook is installed', () => {
    const onAccess = vi.fn();
    (globalThis as any).__varlockOnDynamicConfigAccess = onAccess;
    setPublicDynamicEnv({ [DYNAMIC_KEY]: 'hello-runtime' });
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
    expect(getPublicDynamicConfigKeys()).toEqual(['PUBLIC_DYNAMIC_TEST']);
  });

  it('reads isDynamic from the blob with sensitivity as the fallback linkage', () => {
    process.env.__VARLOCK_ENV = JSON.stringify({
      sources: [],
      settings: {},
      config: {
        // isDynamic omitted - follows isSensitive
        PUBLIC_STATIC_TEST: { value: 'a', isSensitive: false },
        SECRET_TEST: { value: 'b', isSensitive: true },
      },
    });

    initVarlockEnv();

    expect(getDynamicConfigKeys()).toEqual(['SECRET_TEST']);
    expect(getPublicDynamicConfigKeys()).toEqual([]);
  });

  it('throws when a public+dynamic key is accessed during build/prerender phase', () => {
    process.env.__VARLOCK_EXECUTION_PHASE = 'build';
    setPublicDynamicEnv({ [DYNAMIC_KEY]: 'hello-runtime' });
    expect(() => (ENV as any)[DYNAMIC_KEY]).toThrow(/accessed during build/i);
  });

  it('does not guard non-public dynamic keys during build (leak scanning covers output)', () => {
    process.env.__VARLOCK_ENV = JSON.stringify({
      sources: [],
      settings: {},
      config: {
        SECRET_DYNAMIC_TEST: { value: 'shh', isSensitive: true },
      },
    });
    initVarlockEnv();
    process.env.__VARLOCK_EXECUTION_PHASE = 'build';
    expect((ENV as any).SECRET_DYNAMIC_TEST).toBe('shh');
  });

  it('supports downgrading the build guard via _VARLOCK_DYNAMIC_BUILD_ACCESS_MODE=warn', () => {
    process.env.__VARLOCK_EXECUTION_PHASE = 'build';
    process.env._VARLOCK_DYNAMIC_BUILD_ACCESS_MODE = 'warn';
    setPublicDynamicEnv({ [DYNAMIC_KEY]: 'hello-runtime' });
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
    }) as unknown as typeof fetch;

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
    }) as unknown as typeof fetch;

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
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      loadPublicDynamicEnv(),
      loadPublicDynamicEnv(),
    ]);

    expect(fetchCount).toBe(1);
    expect(a).toEqual({ [DYNAMIC_KEY]: 'loaded-concurrent' });
    expect(b).toEqual({ [DYNAMIC_KEY]: 'loaded-concurrent' });
  });
});
