import { describe, it, expect } from 'vitest';
import { CLOUDFLARE_SSR_ENTRY_CODE } from '../src/shared-ssr-entry-code';

// Evaluates the injected entry code with `import('cloudflare:workers')` swapped for a stub,
// since Node rejects the `cloudflare:` scheme. `bindings: undefined` models a non-Workers
// runtime (the import throws); an object models workerd with those bindings.
async function runEntryCode(bindings: Record<string, string> | undefined) {
  const code = CLOUDFLARE_SSR_ENTRY_CODE.replace(
    "import('cloudflare:workers')",
    '__loadWorkers()',
  );
  const g = globalThis as any;
  delete g.__varlockLoadedEnv;
  delete g.__varlockEncryptedEnv;
  const __loadWorkers = async () => {
    if (!bindings) throw new Error("Cannot find module 'cloudflare:workers'");
    return { env: bindings };
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('__loadWorkers', `return (async () => { ${code} })();`);
  try {
    await fn(__loadWorkers);
    return { loaded: g.__varlockLoadedEnv, encrypted: g.__varlockEncryptedEnv };
  } finally {
    delete g.__varlockLoadedEnv;
    delete g.__varlockEncryptedEnv;
  }
}

const serializedEnv = JSON.stringify({ sources: [], settings: {}, config: { A: { value: '1' } } });

describe('CLOUDFLARE_SSR_ENTRY_CODE', () => {
  it('loads the env from the __VARLOCK_ENV binding', async () => {
    const result = await runEntryCode({ __VARLOCK_ENV: serializedEnv });
    expect(result.loaded).toEqual(JSON.parse(serializedEnv));
  });

  it('stashes an encrypted blob for the init module', async () => {
    const result = await runEntryCode({ __VARLOCK_ENV: 'varlock:v1:abc' });
    expect(result.encrypted).toBe('varlock:v1:abc');
    expect(result.loaded).toBeUndefined();
  });

  it('names the fix when the Worker has no binding (stock wrangler dev/deploy)', async () => {
    await expect(runEntryCode({ OTHER: 'x' })).rejects.toThrow(/no __VARLOCK_ENV binding found.*integrations\/cloudflare\/#missing-env-binding/);
  });

  it('stays quiet outside Workers, where the init module reads process.env instead', async () => {
    const result = await runEntryCode(undefined);
    expect(result.loaded).toBeUndefined();
    expect(result.encrypted).toBeUndefined();
  });

  it('does not throw when the env was already baked in (prerender / resolved-env)', async () => {
    (globalThis as any).__varlockLoadedEnv = { preset: true };
    const code = CLOUDFLARE_SSR_ENTRY_CODE.replace("import('cloudflare:workers')", '__loadWorkers()');
    // eslint-disable-next-line no-new-func
    const fn = new Function('__loadWorkers', `return (async () => { ${code} })();`);
    try {
      await expect(fn(async () => ({ env: {} }))).resolves.toBeUndefined();
    } finally {
      delete (globalThis as any).__varlockLoadedEnv;
    }
  });
});
