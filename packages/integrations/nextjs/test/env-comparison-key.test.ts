import {
  describe, it, expect, vi,
} from 'vitest';

vi.mock('varlock/exec-sync-varlock', () => ({
  execSyncVarlock: vi.fn(),
  VarlockExecError: class VarlockExecError extends Error {},
}));
vi.mock('varlock/env', () => ({
  initVarlockEnv: vi.fn(),
  resetRedactionMap: vi.fn(),
}));
vi.mock('varlock/patch-console', () => ({
  patchGlobalConsole: vi.fn(),
}));

const { envComparisonKey } = await import('../src/next-env-compat');

const GRAPH = {
  basePath: '/proj',
  sources: [
    {
      type: 'schema', label: '.env.schema', enabled: true, path: '.env.schema', contentHash: 'aaaaaaaaaaaaaaaa',
    },
  ],
  settings: { redactLogs: true },
  config: { PUBLIC_VAR: { value: 'hello', isSensitive: false } },
};

describe('envComparisonKey', () => {
  it('ignores formatting differences', () => {
    // the CLI pretty-prints `json-full` unless --compact is passed, while the copy kept
    // in process.env.__VARLOCK_ENV is a compact re-stringify
    expect(envComparisonKey(JSON.stringify(GRAPH, null, 2)))
      .toBe(envComparisonKey(JSON.stringify(GRAPH)));
  });

  it('ignores source content fingerprints', () => {
    const edited = {
      ...GRAPH,
      sources: [{ ...GRAPH.sources[0], contentHash: 'bbbbbbbbbbbbbbbb' }],
    };
    expect(envComparisonKey(JSON.stringify(edited))).toBe(envComparisonKey(JSON.stringify(GRAPH)));
  });

  it('ignores source list churn from the reload trigger file', () => {
    // enableExtraFileWatchers creates and deletes a Next-watched .env to trigger reloads,
    // so a load can catch it mid-flight and report a source that resolves nothing
    const withTriggerFile = {
      ...GRAPH,
      sources: [
        ...GRAPH.sources, {
          type: 'values', label: '.env', enabled: false, path: '.env',
        },
      ],
    };
    expect(envComparisonKey(JSON.stringify(withTriggerFile))).toBe(envComparisonKey(JSON.stringify(GRAPH)));
  });

  it('detects a changed resolved value', () => {
    const changed = { ...GRAPH, config: { PUBLIC_VAR: { value: 'goodbye', isSensitive: false } } };
    expect(envComparisonKey(JSON.stringify(changed))).not.toBe(envComparisonKey(JSON.stringify(GRAPH)));
  });

  it('detects an added or removed item', () => {
    const added = {
      ...GRAPH,
      config: { ...GRAPH.config, OTHER_VAR: { value: 'x', isSensitive: false } },
    };
    expect(envComparisonKey(JSON.stringify(added))).not.toBe(envComparisonKey(JSON.stringify(GRAPH)));
  });

  it('detects a changed setting', () => {
    const changed = { ...GRAPH, settings: { redactLogs: false } };
    expect(envComparisonKey(JSON.stringify(changed))).not.toBe(envComparisonKey(JSON.stringify(GRAPH)));
  });

  it('returns undefined for missing or unparseable input', () => {
    expect(envComparisonKey(undefined)).toBeUndefined();
    expect(envComparisonKey('not json')).toBeUndefined();
  });
});
