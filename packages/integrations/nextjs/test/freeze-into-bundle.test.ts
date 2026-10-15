import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { decryptEnvBlobSync } from 'varlock/encrypt-env';

const KEY = 'a'.repeat(64);
const ENV_KEYS = [
  'VERCEL',
  'NETLIFY',
  'WORKERS_CI',
  'AWS_APP_ID',
  'AWS_BRANCH',
  '__VARLOCK_ENV',
  '_VARLOCK_ENV_KEY',
  '_VARLOCK_ALLOW_PLAINTEXT_FROZEN_ENV',
  '__VARLOCK_NEXT_FREEZE_DECISION',
  '__VARLOCK_NEXT_FREEZE_ANNOUNCED',
];

const GRAPH = {
  basePath: '/app',
  sources: [],
  settings: {},
  overrideKeys: ['PUBLIC_FOO'],
  injectedAtBuild: true,
  config: {
    PUBLIC_FOO: { value: 'public-foo', isSensitive: false },
    PORT: { value: 3000, isSensitive: false, boot: { type: 'port', required: false } },
  },
};

async function freshModule() {
  vi.resetModules();
  return import('../src/freeze-into-bundle');
}

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe('decideFreezeIntoBundle', () => {
  it("'auto' freezes on Vercel", async () => {
    process.env.VERCEL = '1';
    const { decideFreezeIntoBundle } = await freshModule();
    expect(decideFreezeIntoBundle('auto')).toMatchObject({ frozen: true, platform: 'Vercel' });
  });

  it("'auto' freezes on Netlify and Cloudflare Workers Builds", async () => {
    process.env.NETLIFY = 'true';
    expect((await freshModule()).decideFreezeIntoBundle()).toMatchObject({ frozen: true, platform: 'Netlify' });
    delete process.env.NETLIFY;
    delete process.env.__VARLOCK_NEXT_FREEZE_DECISION;
    process.env.WORKERS_CI = '1';
    expect((await freshModule()).decideFreezeIntoBundle()).toMatchObject({ frozen: true, platform: 'Cloudflare Workers Builds' });
  });

  it("'auto' resolves at boot anywhere else", async () => {
    const { decideFreezeIntoBundle } = await freshModule();
    expect(decideFreezeIntoBundle('auto')).toMatchObject({ frozen: false });
  });

  it('explicit settings win over detection', async () => {
    process.env.VERCEL = '1';
    expect((await freshModule()).decideFreezeIntoBundle(false)).toMatchObject({ frozen: false, platform: 'Vercel' });
    delete process.env.VERCEL;
    delete process.env.__VARLOCK_NEXT_FREEZE_DECISION;
    expect((await freshModule()).decideFreezeIntoBundle(true)).toMatchObject({ frozen: true, reason: 'freezeIntoBundle: true' });
  });

  it("'auto' freezes on AWS Amplify", async () => {
    process.env.AWS_APP_ID = 'd123';
    process.env.AWS_BRANCH = 'main';
    const { decideFreezeIntoBundle } = await freshModule();
    expect(decideFreezeIntoBundle('auto')).toMatchObject({ frozen: true, platform: 'AWS Amplify' });
  });

  it("a standalone build with 'auto' and no detected platform fails until the choice is explicit", async () => {
    const { decideFreezeIntoBundle } = await freshModule();
    expect(() => decideFreezeIntoBundle('auto', { isStandalone: true }))
      .toThrow(/needs an explicit `freezeIntoBundle` setting/);
    const explicitFalse = (await freshModule()).decideFreezeIntoBundle(false, { isStandalone: true });
    expect(explicitFalse).toMatchObject({ frozen: false });
    delete process.env.__VARLOCK_NEXT_FREEZE_DECISION;
    const explicitTrue = (await freshModule()).decideFreezeIntoBundle(true, { isStandalone: true });
    expect(explicitTrue).toMatchObject({ frozen: true });
  });

  it("a standalone build on a detected platform still freezes with 'auto'", async () => {
    process.env.VERCEL = '1';
    const { decideFreezeIntoBundle } = await freshModule();
    expect(decideFreezeIntoBundle('auto', { isStandalone: true })).toMatchObject({ frozen: true, platform: 'Vercel' });
  });

  it('rejects an unknown value', async () => {
    const { decideFreezeIntoBundle } = await freshModule();
    expect(() => decideFreezeIntoBundle('yes' as any)).toThrow(/must be true, false, or 'auto'/);
  });

  it('build workers reuse the decision made by the main build process', async () => {
    process.env.VERCEL = '1';
    (await freshModule()).decideFreezeIntoBundle('auto');
    // a worker re-evaluates the config in a process where detection might differ
    delete process.env.VERCEL;
    expect((await freshModule()).decideFreezeIntoBundle('auto')).toMatchObject({ frozen: true, platform: 'Vercel' });
  });
});

describe('getFrozenBundlePayload', () => {
  it('applies the freeze policy and encrypts with _VARLOCK_ENV_KEY', async () => {
    process.env.__VARLOCK_ENV = JSON.stringify(GRAPH);
    process.env._VARLOCK_ENV_KEY = KEY;
    const { getFrozenBundlePayload } = await freshModule();
    const {
      payload, encrypted, bootKeys, freezeId,
    } = getFrozenBundlePayload();
    expect(encrypted).toBe(true);
    expect(payload.startsWith('varlock:v1:')).toBe(true);
    expect(bootKeys).toEqual(['PORT']);

    const frozen = JSON.parse(decryptEnvBlobSync(payload, KEY));
    expect(frozen.frozen).toBe(true);
    expect(frozen.overrideKeys).toEqual([]);
    expect(frozen.injectedAtBuild).toBeUndefined();
    expect(frozen.freezeId).toBe(freezeId);
  });

  it('derives the same freezeId from the same resolved env', async () => {
    process.env.__VARLOCK_ENV = JSON.stringify(GRAPH);
    process.env._VARLOCK_ENV_KEY = KEY;
    const first = (await freshModule()).getFrozenBundlePayload().freezeId;
    const second = (await freshModule()).getFrozenBundlePayload().freezeId;
    expect(first).toBe(second);
  });

  it('refuses to freeze without a key unless plaintext is allowed', async () => {
    process.env.__VARLOCK_ENV = JSON.stringify(GRAPH);
    await expect((async () => (await freshModule()).getFrozenBundlePayload())()).rejects.toThrow(/_VARLOCK_ENV_KEY is not set/);

    process.env._VARLOCK_ALLOW_PLAINTEXT_FROZEN_ENV = '1';
    const { payload, encrypted } = (await freshModule()).getFrozenBundlePayload();
    expect(encrypted).toBe(false);
    expect(JSON.parse(payload).frozen).toBe(true);
  });

  it('refuses a graph with errors', async () => {
    process.env.__VARLOCK_ENV = JSON.stringify({ ...GRAPH, errors: { root: ['bad'] } });
    process.env._VARLOCK_ENV_KEY = KEY;
    await expect((async () => (await freshModule()).getFrozenBundlePayload())()).rejects.toThrow(/failed to resolve/);
  });
});

describe('getRuntimePrelude', () => {
  it('bakes nothing when the build is not frozen', async () => {
    process.env.__VARLOCK_ENV = JSON.stringify(GRAPH);
    const mod = await freshModule();
    mod.decideFreezeIntoBundle('auto');
    const prelude = mod.getRuntimePrelude();
    expect(prelude).not.toContain('public-foo');
    expect(prelude).not.toContain('varlock:v1:');
    expect(prelude).toContain('no resolved env reached this Next.js server');
  });

  it('bakes the encrypted frozen env, and the boot-value bundle when there are boot keys', async () => {
    process.env.__VARLOCK_ENV = JSON.stringify(GRAPH);
    process.env._VARLOCK_ENV_KEY = KEY;
    const mod = await freshModule();
    mod.decideFreezeIntoBundle(true);
    const prelude = mod.getRuntimePrelude();
    expect(prelude).toContain('varlock:v1:');
    expect(prelude).not.toContain('public-foo');
    expect(prelude).toContain('__varlockApplyFrozenBootValues');
  });
});
