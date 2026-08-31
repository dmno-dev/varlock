/*
  Tests for the producer/consumer version-skew warning on __VARLOCK_ENV blobs.
  The runtime code parsing a blob can be a different varlock build than the one that
  produced it (bundled integration glue, parent `varlock run` from before an upgrade).
  Patch-level skew is expected and silent; minor/major skew warns once per process.
*/
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { VARLOCK_VERSION } from '../../lib/varlock-version';

const ENV_STATE_KEY = '__varlockEnvState';
const REDACTION_STATE_KEY = '__varlockRedactionState';
const SKEW_WARNED_KEY = '__varlockVersionSkewWarned';

const [selfMajor, selfMinor, selfPatch] = VARLOCK_VERSION.split('.').map((p) => parseInt(p, 10));

function makeEnvBlob(varlockVersion: string | undefined) {
  return JSON.stringify({
    ...varlockVersion !== undefined ? { varlockVersion } : {},
    sources: [],
    settings: {},
    config: { BVS_FOO: { value: 'foo-val', isSensitive: false } },
  });
}

async function importFreshEnvModuleCopy() {
  vi.resetModules();
  return import('../env');
}

function cleanup() {
  delete (globalThis as any)[ENV_STATE_KEY];
  delete (globalThis as any)[REDACTION_STATE_KEY];
  delete (globalThis as any)[SKEW_WARNED_KEY];
  delete process.env.__VARLOCK_ENV;
  delete process.env.BVS_FOO;
  vi.restoreAllMocks();
}

beforeEach(cleanup);
afterEach(cleanup);

async function initWithBlobVersion(varlockVersion: string | undefined) {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  process.env.__VARLOCK_ENV = makeEnvBlob(varlockVersion);
  const envModule = await importFreshEnvModuleCopy();
  envModule.initVarlockEnv();
  return warnSpy;
}

describe('env blob version skew warning', () => {
  it('matching version does not warn', async () => {
    const warnSpy = await initWithBlobVersion(VARLOCK_VERSION);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('unstamped blob (older producer) does not warn', async () => {
    const warnSpy = await initWithBlobVersion(undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('patch-level skew does not warn', async () => {
    const warnSpy = await initWithBlobVersion(`${selfMajor}.${selfMinor}.${selfPatch + 1}`);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('minor-level skew warns, but only once per process', async () => {
    const skewedVersion = `${selfMajor}.${selfMinor + 1}.0`;
    const warnSpy = await initWithBlobVersion(skewedVersion);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(skewedVersion);
    expect(warnSpy.mock.calls[0][0]).toContain(VARLOCK_VERSION);

    // a second init (even via a fresh module copy, as bundlers create) stays quiet
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('major-level skew warns', async () => {
    const warnSpy = await initWithBlobVersion(`${selfMajor + 1}.0.0`);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
