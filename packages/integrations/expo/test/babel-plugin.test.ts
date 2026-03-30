/* eslint-disable @typescript-eslint/no-empty-function */
import {
  describe, it, expect, vi,
} from 'vitest';

// ---------------------------------------------------------------------------
// Load fixture: use varlock's EnvGraph to parse the .env.schema into a real
// SerializedEnvGraph. This ensures the test fixture is parsed exactly the
// same way the production code does, avoiding a hand-rolled parser that can
// drift out of sync.
//
// vi.hoisted() runs before vi.mock() factories. We dynamically import varlock
// (the real one, before it gets mocked) and load the fixture with EnvGraph.
// ---------------------------------------------------------------------------
const FIXTURE_ENV_GRAPH = vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const varlock = await vi.importActual<typeof import('varlock')>('varlock');

  const fixtureContents = readFileSync(join(__dirname, 'fixtures/.env.schema'), 'utf-8');
  const g = new varlock.internal.EnvGraph();
  const source = new varlock.internal.DotEnvFileDataSource('.env.schema', { overrideContents: fixtureContents });
  await g.setRootDataSource(source);
  await g.finishLoad();
  await g.resolveEnvValues();
  return g.getSerializedGraph();
});

// ---------------------------------------------------------------------------
// Mock all varlock dependencies BEFORE the plugin module is imported.
// vi.mock() calls are hoisted to the top of the file by Vitest, so the mocks
// are in place when the module-level `loadVarlockConfig()` runs.
// ---------------------------------------------------------------------------
vi.mock('varlock/exec-sync-varlock', async () => ({
  execSyncVarlock: vi.fn().mockReturnValue(JSON.stringify(await FIXTURE_ENV_GRAPH)),
}));

vi.mock('varlock/env', () => ({
  initVarlockEnv: vi.fn(),
}));

vi.mock('varlock/patch-console', () => ({
  patchGlobalConsole: vi.fn(),
}));

vi.mock('varlock', () => ({
  createDebug: vi.fn().mockReturnValue(vi.fn()),
}));

// Import AFTER mocks so module-level init uses our fixture data.
import varlockExpoBabelPlugin from '../src/babel-plugin';

// ---------------------------------------------------------------------------
// Minimal Babel API + AST-node helpers
// We avoid a hard dependency on @babel/core in tests by driving the plugin's
// visitor directly with lightweight mock objects.
// ---------------------------------------------------------------------------

/** Minimal Babel `t` (types) API that mirrors real Babel nodes closely enough. */
function createMockTypes() {
  return {
    nullLiteral: () => ({ type: 'NullLiteral' }),
    identifier: (name: string) => ({ type: 'Identifier', name }),
    booleanLiteral: (value: boolean) => ({ type: 'BooleanLiteral', value }),
    numericLiteral: (value: number) => ({ type: 'NumericLiteral', value }),
    stringLiteral: (value: string) => ({ type: 'StringLiteral', value }),
    callExpression: (callee: object, args: Array<object>) => ({
      type: 'CallExpression', callee, arguments: args,
    }),
    memberExpression: (obj: object, property: object) => ({
      type: 'MemberExpression', object: obj, property,
    }),
  };
}

const mockTypes = createMockTypes();

function createMockApi() {
  return {
    cache: vi.fn(),
    types: mockTypes,
  };
}

/** Build a mock Babel NodePath for a `MemberExpression`. */
function createNodePath(objectName: string, propertyName: string, computed = false) {
  return {
    node: {
      object: { type: 'Identifier', name: objectName },
      property: { type: 'Identifier', name: propertyName },
      computed,
    },
    replaceWith: vi.fn(),
  };
}

/** Plugin return type from varlockExpoBabelPlugin. */
type PluginResult = {
  name: string;
  visitor: {
    MemberExpression?: (
      p: ReturnType<typeof createNodePath>,
      state: { filename?: string },
    ) => void;
  };
};

// ---------------------------------------------------------------------------
// Helper: create plugin instance and invoke MemberExpression visitor once.
// ---------------------------------------------------------------------------
function visitMemberExpression(
  objectName: string,
  propertyName: string,
  computed = false,
  filename = '/app/page.tsx',
) {
  const api = createMockApi();
  const plugin = varlockExpoBabelPlugin(api) as PluginResult;
  const nodePath = createNodePath(objectName, propertyName, computed);
  plugin.visitor.MemberExpression?.(nodePath, { filename });
  return nodePath.replaceWith;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('varlockExpoBabelPlugin – static value replacement', () => {
  it('replaces ENV.API_URL with a StringLiteral', () => {
    const replaceWith = visitMemberExpression('ENV', 'API_URL');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'StringLiteral', value: 'https://api.example.com' });
  });

  it('replaces ENV.PORT with a NumericLiteral', () => {
    const replaceWith = visitMemberExpression('ENV', 'PORT');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'NumericLiteral', value: 3000 });
  });

  it('replaces ENV.DEBUG with a BooleanLiteral', () => {
    const replaceWith = visitMemberExpression('ENV', 'DEBUG');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'BooleanLiteral', value: true });
  });

  it('replaces ENV.EMPTY with an undefined identifier', () => {
    const replaceWith = visitMemberExpression('ENV', 'EMPTY');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'Identifier', name: 'undefined' });
  });
});

describe('varlockExpoBabelPlugin – sensitive values are NOT replaced', () => {
  it('does NOT replace ENV.SECRET_KEY (isSensitive=true)', () => {
    const replaceWith = visitMemberExpression('ENV', 'SECRET_KEY', false, '/app/api/route+api.ts');
    expect(replaceWith).not.toHaveBeenCalled();
  });
});

describe('varlockExpoBabelPlugin – unknown / irrelevant expressions are skipped', () => {
  it('does NOT replace ENV.UNKNOWN_KEY (key not in config)', () => {
    const replaceWith = visitMemberExpression('ENV', 'UNKNOWN_KEY');
    expect(replaceWith).not.toHaveBeenCalled();
  });

  it('does NOT replace computed access ENV["API_URL"]', () => {
    const replaceWith = visitMemberExpression('ENV', 'API_URL', true);
    expect(replaceWith).not.toHaveBeenCalled();
  });

  it('does NOT replace OTHER.API_URL (object is not ENV)', () => {
    const replaceWith = visitMemberExpression('OTHER', 'API_URL');
    expect(replaceWith).not.toHaveBeenCalled();
  });
});

describe('varlockExpoBabelPlugin – sensitive var build-time warnings', () => {
  it('warns when a sensitive var is accessed in a native (non-server) file', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    visitMemberExpression('ENV', 'SECRET_KEY', false, '/app/screens/Home.tsx');
    expect(warnSpy).toHaveBeenCalledOnce();
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('SECRET_KEY');
    expect(message).toContain('@sensitive');
    expect(message).toContain('/app/screens/Home.tsx');
    warnSpy.mockRestore();
  });

  it('does NOT warn when a sensitive var is accessed in a server +api file', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    visitMemberExpression('ENV', 'SECRET_KEY', false, '/app/api/auth+api.ts');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does NOT warn for non-sensitive vars regardless of file type', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    visitMemberExpression('ENV', 'API_URL', false, '/app/screens/Home.tsx');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('deduplicates warnings for the same key within one plugin invocation', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = createMockApi();
    const plugin = varlockExpoBabelPlugin(api) as PluginResult;
    const state = { filename: '/app/screens/Home.tsx' };

    const path1 = createNodePath('ENV', 'SECRET_KEY');
    plugin.visitor.MemberExpression?.(path1, state);
    const path2 = createNodePath('ENV', 'SECRET_KEY');
    plugin.visitor.MemberExpression?.(path2, state);

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe('varlockExpoBabelPlugin – plugin metadata', () => {
  it('returns the correct plugin name', () => {
    const api = createMockApi();
    const result = varlockExpoBabelPlugin(api) as PluginResult;
    expect(result.name).toBe('varlock-expo-integration');
  });

  it('calls api.cache(false) to disable caching', () => {
    const api = createMockApi();
    varlockExpoBabelPlugin(api);
    expect(api.cache).toHaveBeenCalledWith(false);
  });
});
