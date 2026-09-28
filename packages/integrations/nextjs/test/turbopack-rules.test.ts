import { describe, it, expect } from 'vitest';
import { getTurbopackLoaderRules } from '../src/turbopack-rules';

const GLOB = '*.{js,jsx,ts,tsx,mjs,mts}';

function getRules(nextVersion: [number, number], isBuild = false) {
  return getTurbopackLoaderRules({ nextVersion, loaderPath: '/loader.cjs', isBuild })[GLOB] as any;
}

describe('getTurbopackLoaderRules', () => {
  it('Next 16+: splits browser vs non-browser via `condition`', () => {
    const rules = getRules([16, 0]);
    expect(rules).toEqual([
      { condition: 'browser', loaders: [{ loader: '/loader.cjs', options: { bundler: 'turbopack', dev: true, browser: true } }] },
      { condition: { not: 'browser' }, loaders: [{ loader: '/loader.cjs', options: { bundler: 'turbopack', dev: true } }] },
    ]);
  });

  it('Next 15.5: per-condition object with a browser-flagged rule (edge excluded)', () => {
    const rules = getRules([15, 5]);
    expect(Object.keys(rules)).toEqual(['node', 'browser']);
    expect(rules.node.loaders[0].options.browser).toBeUndefined();
    expect(rules.browser.loaders[0].options.browser).toBe(true);
  });

  it('Next <15.5: a single flat rule (no conditions available)', () => {
    for (const version of [[15, 4], [14, 2]] as Array<[number, number]>) {
      const rules = getRules(version);
      expect(rules.condition).toBeUndefined();
      expect(rules.loaders[0].options).toEqual({ bundler: 'turbopack', dev: true });
    }
  });

  it('passes dev=false for builds', () => {
    expect(getRules([16, 0], true)[0].loaders[0].options.dev).toBe(false);
  });
});
