/**
 * Tests for Environment Schema Store
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EnvSchemaStore } from './index';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

describe('EnvSchemaStore', () => {
  let store: EnvSchemaStore;
  const testDir = '.test-env-schema-store';
  const cacheDir = join(testDir, '.varlock/schema-cache');

  beforeEach(() => {
    // Create test directory
    mkdirSync(testDir, { recursive: true });
    
    // Mock fetch for remote catalog
    global.fetch = vi.fn();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with default config', async () => {
      store = new EnvSchemaStore();
      expect(store).toBeDefined();
    });

    it('should auto-detect framework from package.json', async () => {
      // Create mock package.json with Next.js
      const packageJson = {
        dependencies: {
          'next': '^14.0.0',
          '@sentry/nextjs': '^8.0.0',
        },
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      // Mock catalog response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schemas: [
            {
              name: 'sentry',
              packageNames: ['@sentry/nextjs'],
              schemaFile: 'schemas/sentry.env.schema',
              frameworks: {
                nextjs: {
                  schemaFile: 'schemas/sentry-nextjs.env.schema',
                },
              },
            },
          ],
        }),
      });

      store = new EnvSchemaStore();
      await store.initialize(testDir);

      const schemas = store.getSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0].framework).toBe('nextjs');
    });

    it('should load schemas from local directory', async () => {
      const localSchemaDir = join(testDir, 'schemas');
      mkdirSync(localSchemaDir, { recursive: true });

      // Create local catalog
      const catalog = {
        schemas: [
          {
            name: 'test',
            displayName: 'Test',
            description: 'Test schema',
            category: 'test',
            packageNames: ['test-package'],
            schemaFile: 'test.env.schema',
          },
        ],
      };
      writeFileSync(
        join(localSchemaDir, 'catalog.json'),
        JSON.stringify(catalog, null, 2)
      );

      // Create schema file
      const schemaContent = `# @required @secret
TEST_VAR=`;
      writeFileSync(
        join(localSchemaDir, 'test.env.schema'),
        schemaContent
      );

      store = new EnvSchemaStore({
        localSchemaDir,
        autoDiscovery: false,
        load: ['test'],
      });

      await store.initialize(testDir);

      const schemas = store.getSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0].name).toBe('test');
      expect(schemas[0].content).toContain('TEST_VAR');
    });
  });

  describe('auto-discovery', () => {
    it('should discover schemas from package.json dependencies', async () => {
      const packageJson = {
        dependencies: {
          '@sentry/node': '^8.0.0',
          'stripe': '^13.0.0',
        },
        devDependencies: {
          'prisma': '^5.0.0',
        },
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      // Mock catalog response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schemas: [
            {
              name: 'sentry',
              packageNames: ['@sentry/node'],
              schemaFile: 'schemas/sentry.env.schema',
            },
            {
              name: 'stripe',
              packageNames: ['stripe'],
              schemaFile: 'schemas/stripe.env.schema',
            },
            {
              name: 'prisma',
              packageNames: ['prisma'],
              schemaFile: 'schemas/prisma.env.schema',
            },
          ],
        }),
      });

      // Mock schema file responses
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '# @required\nSENTRY_DSN=',
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '# @required\nSTRIPE_SECRET_KEY=',
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '# @required\nDATABASE_URL=',
        });

      store = new EnvSchemaStore({
        autoDiscovery: true,
      });

      await store.initialize(testDir);

      const schemas = store.getSchemas();
      expect(schemas).toHaveLength(3);
      expect(schemas.map(s => s.name).sort()).toEqual(['prisma', 'sentry', 'stripe']);
    });

    it('should respect exclude list', async () => {
      const packageJson = {
        dependencies: {
          '@sentry/node': '^8.0.0',
          'stripe': '^13.0.0',
        },
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      // Mock catalog response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schemas: [
            {
              name: 'sentry',
              packageNames: ['@sentry/node'],
              schemaFile: 'schemas/sentry.env.schema',
            },
            {
              name: 'stripe',
              packageNames: ['stripe'],
              schemaFile: 'schemas/stripe.env.schema',
            },
          ],
        }),
      });

      // Only mock Sentry schema (Stripe is excluded)
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => '# @required\nSENTRY_DSN=',
      });

      store = new EnvSchemaStore({
        autoDiscovery: true,
        exclude: ['stripe'],
      });

      await store.initialize(testDir);

      const schemas = store.getSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0].name).toBe('sentry');
    });
  });

  describe('version matching', () => {
    it('should select best matching version', async () => {
      const packageJson = {
        dependencies: {
          'sentry': '^7.5.0',
        },
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      // Mock catalog with multiple versions
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schemas: [
            {
              name: 'sentry',
              packageNames: ['sentry'],
              schemaFile: 'schemas/sentry.env.schema',
              versions: {
                '8.0.0': 'schemas/sentry-v8.env.schema',
                '7.0.0': 'schemas/sentry-v7.env.schema',
                '6.0.0': 'schemas/sentry-v6.env.schema',
              },
            },
          ],
        }),
      });

      // Mock v7 schema response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => '# Sentry v7\n# @required\nSENTRY_DSN=',
      });

      store = new EnvSchemaStore({
        autoDiscovery: true,
      });

      await store.initialize(testDir);

      const schemas = store.getSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0].version).toBe('7.0.0');
      expect(schemas[0].content).toContain('Sentry v7');
    });
  });

  describe('validation', () => {
    it('should validate environment variables', async () => {
      const localSchemaDir = join(testDir, 'schemas');
      mkdirSync(localSchemaDir, { recursive: true });

      // Create local catalog
      const catalog = {
        schemas: [
          {
            name: 'test',
            packageNames: ['test'],
            schemaFile: 'test.env.schema',
          },
        ],
      };
      writeFileSync(
        join(localSchemaDir, 'catalog.json'),
        JSON.stringify(catalog, null, 2)
      );

      // Create schema with various requirements
      const schemaContent = `# @required @secret
# @pattern ^sk_[a-z]+_[a-z0-9]+$
API_KEY=

# @optional @public
# @enum development staging production
ENVIRONMENT=

# @suggested @public
DEBUG=`;
      writeFileSync(
        join(localSchemaDir, 'test.env.schema'),
        schemaContent
      );

      store = new EnvSchemaStore({
        localSchemaDir,
        autoDiscovery: false,
        load: ['test'],
      });

      await store.initialize(testDir);

      // Test with valid env
      const validResult = await store.validate({
        API_KEY: 'sk_test_abc123',
        ENVIRONMENT: 'production',
      });

      expect(validResult.valid).toBe(true);
      expect(validResult.errors).toHaveLength(0);
      expect(validResult.missing).toHaveLength(1); // DEBUG is suggested

      // Test with invalid env
      const invalidResult = await store.validate({
        API_KEY: 'invalid-key',
        ENVIRONMENT: 'invalid',
      });

      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors).toHaveLength(1); // Invalid pattern
      expect(invalidResult.errors[0].variable).toBe('API_KEY');

      // Test with missing required
      const missingResult = await store.validate({
        ENVIRONMENT: 'production',
      });

      expect(missingResult.valid).toBe(false);
      expect(missingResult.missing).toHaveLength(2);
      expect(missingResult.missing.find(m => m.variable === 'API_KEY')?.required).toBe(true);
    });
  });

  describe('overrides', () => {
    it('should apply user overrides to schemas', async () => {
      const localSchemaDir = join(testDir, 'schemas');
      mkdirSync(localSchemaDir, { recursive: true });

      // Create catalog
      const catalog = {
        schemas: [
          {
            name: 'test',
            packageNames: ['test'],
            schemaFile: 'test.env.schema',
          },
        ],
      };
      writeFileSync(
        join(localSchemaDir, 'catalog.json'),
        JSON.stringify(catalog, null, 2)
      );

      // Create schema
      const schemaContent = `# @optional @public
VAR1=

# @required @secret
VAR2=

# @optional @public
VAR3=`;
      writeFileSync(
        join(localSchemaDir, 'test.env.schema'),
        schemaContent
      );

      store = new EnvSchemaStore({
        localSchemaDir,
        autoDiscovery: false,
        load: ['test'],
        overrides: {
          test: {
            VAR1: 'required',
            VAR2: 'optional',
            VAR3: 'ignore',
          },
        },
      });

      await store.initialize(testDir);

      const mergedSchema = store.getMergedSchema();
      
      // VAR1 should be required now
      expect(mergedSchema).toContain('@required');
      
      // VAR3 should be removed
      expect(mergedSchema).not.toContain('VAR3=');
    });
  });

  describe('caching', () => {
    it('should cache schema resolution', async () => {
      const packageJson = {
        dependencies: {
          'test-package': '^1.0.0',
        },
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      // Mock catalog response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schemas: [
            {
              name: 'test',
              packageNames: ['test-package'],
              schemaFile: 'schemas/test.env.schema',
            },
          ],
        }),
      });

      // Mock schema response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => '# @required\nTEST_VAR=',
      });

      store = new EnvSchemaStore({
        cacheDir,
      });

      await store.initialize(testDir);

      // First load should fetch from remote
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // Create new store instance with same config
      const store2 = new EnvSchemaStore({
        cacheDir,
      });

      // Reset fetch mock
      vi.clearAllMocks();

      await store2.initialize(testDir);

      // Should load from cache, not fetch
      expect(global.fetch).not.toHaveBeenCalled();

      const schemas = store2.getSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0].name).toBe('test');
    });

    it('should invalidate stale cache', async () => {
      // Create old cache file
      mkdirSync(cacheDir, { recursive: true });
      const oldCache = {
        timestamp: Date.now() - (25 * 60 * 60 * 1000), // 25 hours ago
        schemas: {
          'old-schema': {
            name: 'old-schema',
            content: '# Old content',
            source: 'auto',
            priority: 50,
          },
        },
      };
      const cacheKey = 'test-cache-key';
      writeFileSync(
        join(cacheDir, `${cacheKey}.json`),
        JSON.stringify(oldCache, null, 2)
      );

      // Mock to return same cache key
      store = new EnvSchemaStore({
        cacheDir,
      });
      (store as any).cacheKey = cacheKey;

      // Mock catalog response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ schemas: [] }),
      });

      await store.initialize(testDir);

      // Should have fetched new data due to stale cache
      expect(global.fetch).toHaveBeenCalled();
      
      // Should not have old schema
      const schemas = store.getSchemas();
      expect(schemas.find(s => s.name === 'old-schema')).toBeUndefined();
    });
  });

  describe('merged schema', () => {
    it('should generate merged schema with all loaded schemas', async () => {
      const localSchemaDir = join(testDir, 'schemas');
      mkdirSync(localSchemaDir, { recursive: true });

      // Create catalog with multiple schemas
      const catalog = {
        schemas: [
          {
            name: 'schema1',
            packageNames: ['package1'],
            schemaFile: 'schema1.env.schema',
          },
          {
            name: 'schema2',
            packageNames: ['package2'],
            schemaFile: 'schema2.env.schema',
          },
        ],
      };
      writeFileSync(
        join(localSchemaDir, 'catalog.json'),
        JSON.stringify(catalog, null, 2)
      );

      // Create schema files
      writeFileSync(
        join(localSchemaDir, 'schema1.env.schema'),
        '# @required\nVAR1='
      );
      writeFileSync(
        join(localSchemaDir, 'schema2.env.schema'),
        '# @optional\nVAR2='
      );

      store = new EnvSchemaStore({
        localSchemaDir,
        autoDiscovery: false,
        load: ['schema1', 'schema2'],
      });

      await store.initialize(testDir);

      const merged = store.getMergedSchema();
      
      expect(merged).toContain('Environment Schema Store - Auto-generated');
      expect(merged).toContain('schema1');
      expect(merged).toContain('schema2');
      expect(merged).toContain('VAR1=');
      expect(merged).toContain('VAR2=');
    });

    it('should respect priority order in merged schema', async () => {
      const localSchemaDir = join(testDir, 'schemas');
      mkdirSync(localSchemaDir, { recursive: true });

      // Create catalog
      const catalog = {
        schemas: [
          {
            name: 'auto-schema',
            packageNames: ['auto-package'],
            schemaFile: 'auto.env.schema',
          },
          {
            name: 'explicit-schema',
            packageNames: ['explicit-package'],
            schemaFile: 'explicit.env.schema',
          },
        ],
      };
      writeFileSync(
        join(localSchemaDir, 'catalog.json'),
        JSON.stringify(catalog, null, 2)
      );

      // Create schema files
      writeFileSync(
        join(localSchemaDir, 'auto.env.schema'),
        '# Auto-discovered\nAUTO_VAR='
      );
      writeFileSync(
        join(localSchemaDir, 'explicit.env.schema'),
        '# Explicitly loaded\nEXPLICIT_VAR='
      );

      // Create package.json for auto-discovery
      const packageJson = {
        dependencies: {
          'auto-package': '^1.0.0',
        },
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      store = new EnvSchemaStore({
        localSchemaDir,
        autoDiscovery: true,
        load: ['explicit-schema'], // Explicit load has higher priority
      });

      await store.initialize(testDir);

      const schemas = store.getSchemas();
      
      // Explicit should come first (higher priority)
      expect(schemas[0].name).toBe('explicit-schema');
      expect(schemas[0].source).toBe('explicit');
      expect(schemas[0].priority).toBe(100);
      
      expect(schemas[1].name).toBe('auto-schema');
      expect(schemas[1].source).toBe('auto');
      expect(schemas[1].priority).toBe(50);
    });
  });
});