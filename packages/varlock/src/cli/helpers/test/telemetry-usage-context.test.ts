import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import outdent from 'outdent';
import path from 'node:path';
import {
  parseIntegrationFromEnv,
  sanitizeIntegrationIdentity,
  sanitizeFeatureIdentifier,
  sanitizePluginForTelemetry,
  classifyGraphTelemetryErrorCode,
  classifyThrownTelemetryErrorCode,
  captureUsageContextFromEnvGraph,
  captureTelemetryGraphLoadFailure,
  getTelemetryUsageContext,
  getTelemetryUsageContextPayload,
  resetTelemetryUsageContextForTests,
} from '../telemetry-usage-context';
import { EnvGraph, DotEnvFileDataSource } from '../../../env-graph';
import {
  ParseError, SchemaError, LoadingError,
} from '../../../env-graph/lib/errors';

describe('parseIntegrationFromEnv', () => {
  it('returns null for empty values', () => {
    expect(parseIntegrationFromEnv(undefined)).toBeNull();
    expect(parseIntegrationFromEnv('')).toBeNull();
    expect(parseIntegrationFromEnv('   ')).toBeNull();
  });

  it('parses scoped @varlock integration package name and version', () => {
    expect(parseIntegrationFromEnv('@varlock/vite-integration@1.1.3')).toEqual({
      name: '@varlock/vite-integration',
      version: '1.1.3',
    });
  });

  it('rejects unscoped or non-@varlock integration strings', () => {
    expect(parseIntegrationFromEnv('custom-integration')).toBeNull();
    expect(parseIntegrationFromEnv('@acme/custom-integration@1.0.0')).toBeNull();
    expect(parseIntegrationFromEnv('user@example.com@1.0.0')).toBeNull();
  });

  it('rejects oversized integration env values', () => {
    expect(parseIntegrationFromEnv(`@varlock/vite-integration@${'1'.repeat(200)}`)).toBeNull();
  });
});

describe('sanitizeIntegrationIdentity', () => {
  it('accepts official integration packages only', () => {
    expect(sanitizeIntegrationIdentity({
      name: '@varlock/nextjs-integration',
      version: '1.1.3',
    })).toEqual({
      name: '@varlock/nextjs-integration',
      version: '1.1.3',
    });
  });

  it('rejects third-party package names', () => {
    expect(sanitizeIntegrationIdentity({
      name: '@acme/internal-vite-plugin',
      version: '2.0.0',
    })).toBeNull();
  });
});

describe('sanitizeFeatureIdentifier', () => {
  it('drops internal resolver names', () => {
    expect(sanitizeFeatureIdentifier('\0static')).toBeNull();
  });

  it('drops identifiers with unsafe characters', () => {
    expect(sanitizeFeatureIdentifier('pass(user-email)')).toBeNull();
    expect(sanitizeFeatureIdentifier('../path')).toBeNull();
  });

  it('keeps safe builtin-style identifiers', () => {
    expect(sanitizeFeatureIdentifier('forEnv')).toBe('forEnv');
    expect(sanitizeFeatureIdentifier('redactLogs')).toBe('redactLogs');
  });
});

describe('sanitizePluginForTelemetry', () => {
  it('hashes third-party plugin names and omits version', () => {
    const result = sanitizePluginForTelemetry({
      name: '@acme/internal-secrets-plugin',
      version: '9.9.9',
      type: 'package',
      warnings: [],
    });
    expect(result.name_is_hashed).toBe(true);
    expect(result.name).toMatch(/^[a-f0-9]{64}$/);
    expect(result.version).toBeNull();
    expect(result.is_official).toBe(false);
  });

  it('preserves @varlock plugin name and version', () => {
    const result = sanitizePluginForTelemetry({
      name: '@varlock/pass-plugin',
      version: '0.4.0',
      type: 'package',
      warnings: [],
    });
    expect(result.name_is_hashed).toBe(false);
    expect(result.name).toBe('@varlock/pass-plugin');
    expect(result.version).toBe('0.4.0');
  });
});

describe('captureUsageContextFromEnvGraph', () => {
  beforeEach(() => {
    resetTelemetryUsageContextForTests();
    delete process.env.__VARLOCK_INTEGRATION;
  });

  afterEach(() => {
    resetTelemetryUsageContextForTests();
    delete process.env.__VARLOCK_INTEGRATION;
  });

  it('extracts plugins, resolver names, and settings from a loaded graph', async () => {
    const testDir = path.join(
      path.dirname(expect.getState().testPath!),
      '../../../env-graph/test',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);

    const graph = new EnvGraph();
    const source = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @plugin(./plugins/test-plugin/)
        # @redactLogs
        # ---
        PLUGIN_RESOLVER_TEST=test(foo)
      `,
    });
    await graph.setRootDataSource(source);
    await graph.finishLoad();

    captureUsageContextFromEnvGraph(graph);

    const ctx = getTelemetryUsageContext();
    expect(ctx.plugins.length).toBeGreaterThan(0);
    expect(ctx.plugins[0].is_official).toBe(true);
    expect(ctx.plugins[0].name).toBe('@varlock/test-plugin');
    expect(ctx.plugins[0].version).toBe('1.2.3');
    expect(ctx.plugins[0].name_is_hashed).toBe(false);
    expect(ctx.features?.resolver_names).toContain('test');
    expect(ctx.features?.root_decorator_names).toContain('plugin');
    expect(ctx.features?.settings.redactLogs).toBe(true);
    expect(ctx.features?.config_item_count).toBeGreaterThan(0);
    expect(ctx.features?.source_type_counts.schema).toBeGreaterThan(0);
    expect(ctx.graph_loaded).toBe(true);
    expect(ctx.error_code).toBeNull();
  });

  it('includes integration env in telemetry payload when valid', () => {
    process.env.__VARLOCK_INTEGRATION = '@varlock/astro-integration@1.0.4';

    const payload = getTelemetryUsageContextPayload();
    expect(payload.integration_name).toBe('@varlock/astro-integration');
    expect(payload.integration_version).toBe('1.0.4');
    expect(payload.plugins).toEqual([]);
    expect(payload.features).toBeNull();
    expect(payload.graph_loaded).toBe(false);
    expect(payload.error_code).toBeNull();
  });

  it('re-classifies error_code from live graph state at send time', async () => {
    const testDir = path.join(
      path.dirname(expect.getState().testPath!),
      '../../../env-graph/test',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);

    const graph = new EnvGraph();
    await graph.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # ---
        FOO=bar
      `,
    }));
    await graph.finishLoad();

    captureUsageContextFromEnvGraph(graph);
    expect(getTelemetryUsageContextPayload().error_code).toBeNull();

    graph.sortedDataSources[0]._errors.push(new SchemaError('bad schema'));
    const payload = getTelemetryUsageContextPayload();
    expect(payload.graph_loaded).toBe(true);
    expect(payload.error_code).toBe('schema_error');
  });

  it('records load failures before a graph is returned', () => {
    captureTelemetryGraphLoadFailure(new ParseError('bad syntax'));
    const payload = getTelemetryUsageContextPayload();
    expect(payload.graph_loaded).toBe(false);
    expect(payload.error_code).toBe('parse_error');
    expect(payload.features).toBeNull();
  });
});

describe('classifyGraphTelemetryErrorCode', () => {
  it('returns null for a graph with no blocking errors', () => {
    const graph = {
      plugins: [],
      sortedDataSources: [{ loadingError: undefined, errors: [], resolutionErrors: [] }],
      sortedConfigKeys: ['FOO'],
      configSchema: { FOO: { validationState: 'valid' } },
    } as unknown as EnvGraph;
    expect(classifyGraphTelemetryErrorCode(graph)).toBeNull();
  });

  it('prioritizes plugin_error over schema_error', () => {
    const graph = {
      plugins: [{ loadingError: new LoadingError('plugin failed') }],
      sortedDataSources: [{ errors: [new SchemaError('bad')], resolutionErrors: [] }],
      sortedConfigKeys: [],
      configSchema: {},
    } as unknown as EnvGraph;
    expect(classifyGraphTelemetryErrorCode(graph)).toBe('plugin_error');
  });

  it('returns validation_error when items fail validation', () => {
    const graph = {
      plugins: [],
      sortedDataSources: [{ errors: [], resolutionErrors: [] }],
      sortedConfigKeys: ['API_KEY'],
      configSchema: { API_KEY: { validationState: 'error' } },
    } as unknown as EnvGraph;
    expect(classifyGraphTelemetryErrorCode(graph)).toBe('validation_error');
  });
});

describe('classifyThrownTelemetryErrorCode', () => {
  it('maps Varlock error types', () => {
    expect(classifyThrownTelemetryErrorCode(new ParseError('x'))).toBe('parse_error');
    expect(classifyThrownTelemetryErrorCode(new SchemaError('x'))).toBe('schema_error');
    expect(classifyThrownTelemetryErrorCode(new LoadingError('x'))).toBe('load_error');
  });

  it('defaults unknown errors to load_error', () => {
    expect(classifyThrownTelemetryErrorCode(new Error('boom'))).toBe('load_error');
  });
});

describe('integration env sanitization in payload', () => {
  beforeEach(() => {
    resetTelemetryUsageContextForTests();
    delete process.env.__VARLOCK_INTEGRATION;
  });

  it('ignores invalid integration env values in telemetry payload', () => {
    process.env.__VARLOCK_INTEGRATION = 'not-a-valid-integration@secret-data';

    const payload = getTelemetryUsageContextPayload();
    expect(payload.integration_name).toBeNull();
    expect(payload.integration_version).toBeNull();
  });
});
