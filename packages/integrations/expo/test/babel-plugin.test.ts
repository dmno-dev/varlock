import {
  describe, it, expect, vi, beforeAll,
} from 'vitest';
import type { SerializedEnvGraph } from 'varlock';

// ---------------------------------------------------------------------------
// Fixture: the environment graph returned by `varlock load --format json-full`
// ---------------------------------------------------------------------------
const MOCK_ENV_GRAPH: SerializedEnvGraph = {
  basePath: '/project',
  sources: [{ label: '.env', enabled: true, path: '.env' }],
  settings: {},
  config: {
    // string value
    API_URL: { value: 'https://api.example.com', isSensitive: false },
    // number value
    PORT: { value: 3000, isSensitive: false },
    // boolean value
    DEBUG: { value: true, isSensitive: false },
    // null value
    EMPTY: { value: null, isSensitive: false },
    // undefined value
    OPTIONAL: { value: undefined, isSensitive: false },
    // object value (should be serialised via JSON.parse at runtime)
    METADATA: { value: { region: 'us-east-1' }, isSensitive: false },
    // sensitive – must NEVER be inlined
    SECRET_KEY: { value: 's3cr3t', isSensitive: true },
  },
};

// ---------------------------------------------------------------------------
// Mock all varlock dependencies BEFORE the plugin module is imported.
// vi.mock() calls are hoisted to the top of the file by Vitest, so the mocks
// are in place when the module-level `loadVarlockConfig()` runs.
// ---------------------------------------------------------------------------
vi.mock('varlock/exec-sync-varlock', () => ({
  execSyncVarlock: vi.fn().mockReturnValue(JSON.stringify(MOCK_ENV_GRAPH)),
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

// Import AFTER mocks so module-level init uses our mock data.
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

// ---------------------------------------------------------------------------
// Named types for mock AST nodes to improve readability and type safety.
// ---------------------------------------------------------------------------

type MockIdentifier = { type: 'Identifier'; name: string };
type MockMemberExpression = { type: 'MemberExpression'; object: MockIdentifier; property: MockIdentifier };
type MockCallExpressionNode = {
  type: 'CallExpression';
  callee: MockMemberExpression;
  arguments: Array<{ type: string; value: string }>;
};

/** Plugin return type from varlockExpoBabelPlugin. */
type PluginResult = {
  name: string;
  visitor: { MemberExpression?: (p: ReturnType<typeof createNodePath>) => void };
};

// ---------------------------------------------------------------------------
// Helper: create plugin instance and invoke MemberExpression visitor once.
// ---------------------------------------------------------------------------
function visitMemberExpression(
  objectName: string,
  propertyName: string,
  computed = false,
) {
  const api = createMockApi();
  const plugin = varlockExpoBabelPlugin(api) as PluginResult;
  const nodePath = createNodePath(objectName, propertyName, computed);
  plugin.visitor.MemberExpression?.(nodePath);
  return nodePath.replaceWith;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('varlockExpoBabelPlugin – module initialisation', () => {
  it('calls execSyncVarlock to load env at startup', async () => {
    const { execSyncVarlock } = await import('varlock/exec-sync-varlock');
    expect(execSyncVarlock).toHaveBeenCalledWith(
      'load --format json-full',
      expect.objectContaining({ showLogsOnError: true }),
    );
  });

  it('calls initVarlockEnv after loading', async () => {
    const { initVarlockEnv } = await import('varlock/env');
    expect(initVarlockEnv).toHaveBeenCalled();
  });

  it('calls patchGlobalConsole after loading', async () => {
    const { patchGlobalConsole } = await import('varlock/patch-console');
    expect(patchGlobalConsole).toHaveBeenCalled();
  });
});

describe('varlockExpoBabelPlugin – static value replacement', () => {
  beforeAll(() => {
    // Confirm the plugin loaded successfully before running these tests.
    const api = createMockApi();
    const result = varlockExpoBabelPlugin(api) as PluginResult;
    expect(result.visitor).toBeDefined();
  });

  it('replaces ENV.API_URL with a StringLiteral for string values', () => {
    const replaceWith = visitMemberExpression('ENV', 'API_URL');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'StringLiteral', value: 'https://api.example.com' });
  });

  it('replaces ENV.PORT with a NumericLiteral for number values', () => {
    const replaceWith = visitMemberExpression('ENV', 'PORT');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'NumericLiteral', value: 3000 });
  });

  it('replaces ENV.DEBUG with a BooleanLiteral for boolean values', () => {
    const replaceWith = visitMemberExpression('ENV', 'DEBUG');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'BooleanLiteral', value: true });
  });

  it('replaces ENV.EMPTY with a NullLiteral for null values', () => {
    const replaceWith = visitMemberExpression('ENV', 'EMPTY');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'NullLiteral' });
  });

  it('replaces ENV.OPTIONAL with an Identifier(undefined) for undefined values', () => {
    const replaceWith = visitMemberExpression('ENV', 'OPTIONAL');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'Identifier', name: 'undefined' });
  });

  it('replaces ENV.METADATA with a JSON.parse CallExpression for object values', () => {
    const replaceWith = visitMemberExpression('ENV', 'METADATA');
    expect(replaceWith).toHaveBeenCalledOnce();
    const [node] = replaceWith.mock.calls[0] as [MockCallExpressionNode];
    expect(node.type).toBe('CallExpression');
    // callee should be JSON.parse
    expect(node.callee.type).toBe('MemberExpression');
    expect(node.callee.object).toEqual({ type: 'Identifier', name: 'JSON' });
    expect(node.callee.property).toEqual({ type: 'Identifier', name: 'parse' });
    // argument should be a StringLiteral containing the serialised object
    expect(node.arguments[0]).toEqual({
      type: 'StringLiteral',
      value: '{"region":"us-east-1"}',
    });
  });
});

describe('varlockExpoBabelPlugin – sensitive values are NOT replaced', () => {
  it('does NOT replace ENV.SECRET_KEY (isSensitive=true)', () => {
    const replaceWith = visitMemberExpression('ENV', 'SECRET_KEY');
    expect(replaceWith).not.toHaveBeenCalled();
  });
});

describe('varlockExpoBabelPlugin – unknown / irrelevant expressions are skipped', () => {
  it('does NOT replace ENV.UNKNOWN_KEY (key not in config)', () => {
    const replaceWith = visitMemberExpression('ENV', 'UNKNOWN_KEY');
    expect(replaceWith).not.toHaveBeenCalled();
  });

  it('does NOT replace computed access ENV["API_URL"]', () => {
    // When computed=true the property is a dynamic expression, not a plain identifier
    const replaceWith = visitMemberExpression('ENV', 'API_URL', true);
    expect(replaceWith).not.toHaveBeenCalled();
  });

  it('does NOT replace OTHER.API_URL (object is not ENV)', () => {
    const replaceWith = visitMemberExpression('OTHER', 'API_URL');
    expect(replaceWith).not.toHaveBeenCalled();
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
