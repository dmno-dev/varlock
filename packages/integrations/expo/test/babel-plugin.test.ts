import {
  describe, it, expect, vi,
} from 'vitest';

// ---------------------------------------------------------------------------
// Load fixture: parse the .env.schema file into a mock SerializedEnvGraph.
//
// vi.hoisted() runs before vi.mock() factories, making the loaded fixture
// data available to the mock setup. We read the real .env.schema fixture
// rather than hardcoding mock data so the test stays in sync with what
// varlock would actually produce.
// ---------------------------------------------------------------------------
const FIXTURE_ENV_GRAPH = vi.hoisted(() => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');

  type Config = Record<string, { value: unknown; isSensitive: boolean }>;
  const raw = readFileSync(join(__dirname, 'fixtures/.env.schema'), 'utf-8') as string;
  const lines = raw.split('\n');
  const config: Config = {};

  let inHeader = true;
  let defaultSensitive = true;
  let nextSensitive: boolean | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inHeader) {
      const match = trimmed.match(/^#\s*@defaultSensitive\s*=\s*(\w+)/);
      if (match) defaultSensitive = match[1] !== 'false';
      if (trimmed === '# ---') inHeader = false;
      continue;
    }
    if (trimmed.match(/^#\s*@sensitive\b/)) {
      nextSensitive = true;
      continue;
    }
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    config[key] = { value, isSensitive: nextSensitive ?? defaultSensitive };
    nextSensitive = undefined;
  }

  return {
    basePath: join(__dirname, 'fixtures'),
    sources: [{ label: '.env.schema', enabled: true, path: '.env.schema' }],
    settings: {},
    config,
  };
});

// ---------------------------------------------------------------------------
// Mock all varlock dependencies BEFORE the plugin module is imported.
// vi.mock() calls are hoisted to the top of the file by Vitest, so the mocks
// are in place when the module-level `loadVarlockConfig()` runs.
// ---------------------------------------------------------------------------
vi.mock('varlock/exec-sync-varlock', () => ({
  execSyncVarlock: vi.fn().mockReturnValue(JSON.stringify(FIXTURE_ENV_GRAPH)),
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

  it('replaces ENV.PORT with a StringLiteral for numeric-looking values', () => {
    const replaceWith = visitMemberExpression('ENV', 'PORT');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'StringLiteral', value: '3000' });
  });

  it('replaces ENV.DEBUG with a StringLiteral for boolean-like values', () => {
    const replaceWith = visitMemberExpression('ENV', 'DEBUG');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'StringLiteral', value: 'true' });
  });

  it('replaces ENV.EMPTY with a StringLiteral for empty values', () => {
    const replaceWith = visitMemberExpression('ENV', 'EMPTY');
    expect(replaceWith).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledWith({ type: 'StringLiteral', value: '' });
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
