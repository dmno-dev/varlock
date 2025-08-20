/**
 * Environment Schema Store
 * Auto-discovery and loading of environment variable schemas from a centralized registry
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import * as semver from 'semver';

export interface SchemaStoreConfig {
  /**
   * Enable auto-discovery of schemas from package.json
   * @default true
   */
  autoDiscovery?: boolean;

  /**
   * Cache directory for schema resolution
   * @default '.varlock/schema-cache'
   */
  cacheDir?: string;

  /**
   * Schema store base URL or local path
   * @default 'https://env-schema-store.varlock.io'
   */
  storeUrl?: string;

  /**
   * Custom schema directory (for local development)
   */
  localSchemaDir?: string;

  /**
   * Enable telemetry for schema usage
   * @default false
   */
  telemetry?: boolean;

  /**
   * Framework detection (auto-detected from package.json if not specified)
   */
  framework?: 'nextjs' | 'vite' | 'astro' | 'remix' | 'nuxt' | 'sveltekit';

  /**
   * Explicitly load these schemas
   */
  load?: string[];

  /**
   * Explicitly exclude these schemas (even if auto-discovered)
   */
  exclude?: string[];

  /**
   * Override schema priorities
   */
  overrides?: Record<string, {
    [key: string]: 'required' | 'optional' | 'suggested' | 'ignore';
  }>;
}

export interface SchemaEntry {
  name: string;
  displayName: string;
  description: string;
  category: string;
  url?: string;
  packageNames: string[];
  schemaFile: string;
  versions?: Record<string, string>;
  frameworks?: Record<string, {
    envPrefix?: string[];
    schemaFile: string;
  }>;
}

export interface LoadedSchema {
  name: string;
  version?: string;
  framework?: string;
  content: string;
  source: 'auto' | 'explicit' | 'vendor';
  priority: number;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: Array<{
    variable: string;
    message: string;
    severity: 'error' | 'warning' | 'info';
  }>;
  missing: Array<{
    variable: string;
    required: boolean;
    suggested: boolean;
    description?: string;
  }>;
}

export class EnvSchemaStore {
  private config: Required<SchemaStoreConfig>;
  private catalog: { schemas: SchemaEntry[] } | null = null;
  private loadedSchemas: Map<string, LoadedSchema> = new Map();
  private packageJson: any = null;
  private cacheKey: string | null = null;

  constructor(config: SchemaStoreConfig = {}) {
    this.config = {
      autoDiscovery: config.autoDiscovery ?? true,
      cacheDir: config.cacheDir ?? '.varlock/schema-cache',
      storeUrl: config.storeUrl ?? 'https://env-schema-store.varlock.io',
      localSchemaDir: config.localSchemaDir,
      telemetry: config.telemetry ?? false,
      framework: config.framework,
      load: config.load ?? [],
      exclude: config.exclude ?? [],
      overrides: config.overrides ?? {},
    };
  }

  /**
   * Initialize the schema store
   */
  async initialize(projectRoot?: string): Promise<void> {
    const root = projectRoot || process.cwd();
    
    // Load package.json
    const packageJsonPath = join(root, 'package.json');
    if (existsSync(packageJsonPath)) {
      this.packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      
      // Auto-detect framework if not specified
      if (!this.config.framework) {
        this.config.framework = this.detectFramework();
      }
    }

    // Load catalog
    await this.loadCatalog();

    // Generate cache key
    this.cacheKey = this.generateCacheKey();

    // Check cache
    if (await this.loadFromCache()) {
      return;
    }

    // Perform auto-discovery
    if (this.config.autoDiscovery && this.packageJson) {
      await this.discoverSchemas();
    }

    // Load explicitly specified schemas
    for (const schemaSpec of this.config.load) {
      await this.loadSchema(schemaSpec, 'explicit');
    }

    // Save to cache
    await this.saveToCache();
  }

  /**
   * Detect framework from package.json
   */
  private detectFramework(): SchemaStoreConfig['framework'] | undefined {
    if (!this.packageJson) return undefined;

    const deps = {
      ...this.packageJson.dependencies,
      ...this.packageJson.devDependencies,
    };

    if (deps['next']) return 'nextjs';
    if (deps['vite']) return 'vite';
    if (deps['astro']) return 'astro';
    if (deps['@remix-run/react']) return 'remix';
    if (deps['nuxt']) return 'nuxt';
    if (deps['@sveltejs/kit']) return 'sveltekit';

    return undefined;
  }

  /**
   * Load the schema catalog
   */
  private async loadCatalog(): Promise<void> {
    if (this.config.localSchemaDir) {
      // Load from local directory
      const catalogPath = join(this.config.localSchemaDir, 'catalog.json');
      if (existsSync(catalogPath)) {
        this.catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
      }
    } else {
      // Load from remote store
      const response = await fetch(`${this.config.storeUrl}/api/catalog.json`);
      this.catalog = await response.json();
    }
  }

  /**
   * Discover schemas from installed packages
   */
  private async discoverSchemas(): Promise<void> {
    if (!this.catalog || !this.packageJson) return;

    const allDeps = {
      ...this.packageJson.dependencies,
      ...this.packageJson.devDependencies,
    };

    for (const [packageName, version] of Object.entries(allDeps)) {
      // Skip if explicitly excluded
      if (this.config.exclude.includes(packageName)) {
        continue;
      }

      // Find matching schema in catalog
      const schema = this.catalog.schemas.find(s => 
        s.packageNames.includes(packageName)
      );

      if (schema) {
        // Determine the best version match
        const schemaVersion = this.findBestVersionMatch(
          schema,
          version as string
        );

        await this.loadSchemaEntry(schema, schemaVersion, 'auto');
      }
    }

    // Check for vendor-provided schemas
    await this.checkVendorSchemas();
  }

  /**
   * Find the best matching schema version
   */
  private findBestVersionMatch(
    schema: SchemaEntry,
    packageVersion: string
  ): string | undefined {
    if (!schema.versions) return undefined;

    const versions = Object.keys(schema.versions);
    const cleanVersion = packageVersion.replace(/^[^0-9]*/, '');

    // Find the best semver match
    for (const schemaVersion of versions.reverse()) {
      if (semver.satisfies(cleanVersion, schemaVersion)) {
        return schemaVersion;
      }
    }

    return undefined;
  }

  /**
   * Load a specific schema entry
   */
  private async loadSchemaEntry(
    schema: SchemaEntry,
    version?: string,
    source: LoadedSchema['source'] = 'auto'
  ): Promise<void> {
    // Determine schema file based on framework and version
    let schemaFile = schema.schemaFile;
    
    if (this.config.framework && schema.frameworks?.[this.config.framework]) {
      schemaFile = schema.frameworks[this.config.framework].schemaFile;
    }
    
    if (version && schema.versions?.[version]) {
      schemaFile = schema.versions[version];
    }

    // Load schema content
    let content: string;
    
    if (this.config.localSchemaDir) {
      const filePath = join(this.config.localSchemaDir, schemaFile);
      if (existsSync(filePath)) {
        content = readFileSync(filePath, 'utf-8');
      } else {
        return;
      }
    } else {
      const response = await fetch(`${this.config.storeUrl}/${schemaFile}`);
      if (!response.ok) return;
      content = await response.text();
    }

    // Apply overrides
    content = this.applyOverrides(schema.name, content);

    // Store loaded schema
    this.loadedSchemas.set(schema.name, {
      name: schema.name,
      version,
      framework: this.config.framework,
      content,
      source,
      priority: source === 'explicit' ? 100 : 50,
    });

    // Send telemetry if enabled
    if (this.config.telemetry) {
      await this.sendTelemetry(schema.name, version, source);
    }
  }

  /**
   * Load a schema by specification (e.g., "sentry@8.0.0" or "stripe(nextjs)")
   */
  private async loadSchema(
    spec: string,
    source: LoadedSchema['source']
  ): Promise<void> {
    const match = spec.match(/^([a-z0-9-]+)(?:@([0-9.]+))?(?:\(([a-z]+)\))?$/);
    if (!match) return;

    const [, name, version, framework] = match;
    
    const schema = this.catalog?.schemas.find(s => s.name === name);
    if (!schema) return;

    // Override framework if specified
    const originalFramework = this.config.framework;
    if (framework) {
      this.config.framework = framework as any;
    }

    await this.loadSchemaEntry(schema, version, source);

    // Restore original framework
    this.config.framework = originalFramework;
  }

  /**
   * Check for vendor-provided schemas in node_modules
   */
  private async checkVendorSchemas(): Promise<void> {
    if (!this.packageJson) return;

    const allDeps = Object.keys({
      ...this.packageJson.dependencies,
      ...this.packageJson.devDependencies,
    });

    for (const packageName of allDeps) {
      // Skip if explicitly excluded
      if (this.config.exclude.includes(packageName)) {
        continue;
      }

      // Check for package.env.schema in package root
      const schemaPath = join(
        process.cwd(),
        'node_modules',
        packageName,
        'package.env.schema'
      );

      if (existsSync(schemaPath)) {
        const content = readFileSync(schemaPath, 'utf-8');
        
        this.loadedSchemas.set(`vendor:${packageName}`, {
          name: packageName,
          content: this.applyOverrides(packageName, content),
          source: 'vendor',
          priority: 75, // Higher than auto, lower than explicit
        });
      }

      // Check for env-schema entry in package.json
      try {
        const pkgJsonPath = join(
          process.cwd(),
          'node_modules',
          packageName,
          'package.json'
        );
        
        if (existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          
          if (pkgJson['env-schema']) {
            const schemaFile = join(
              process.cwd(),
              'node_modules',
              packageName,
              pkgJson['env-schema']
            );
            
            if (existsSync(schemaFile)) {
              const content = readFileSync(schemaFile, 'utf-8');
              
              this.loadedSchemas.set(`vendor:${packageName}`, {
                name: packageName,
                content: this.applyOverrides(packageName, content),
                source: 'vendor',
                priority: 75,
              });
            }
          }
        }
      } catch {
        // Ignore errors reading package.json
      }
    }
  }

  /**
   * Apply user overrides to schema content
   */
  private applyOverrides(schemaName: string, content: string): string {
    const overrides = this.config.overrides[schemaName];
    if (!overrides) return content;

    let modifiedContent = content;

    for (const [variable, priority] of Object.entries(overrides)) {
      if (priority === 'ignore') {
        // Remove the variable definition
        const regex = new RegExp(`^.*${variable}=.*$`, 'gm');
        modifiedContent = modifiedContent.replace(regex, '');
      } else {
        // Change the priority
        const regex = new RegExp(
          `(^.*@(?:required|optional|suggested))(.*${variable}=.*)$`,
          'gm'
        );
        modifiedContent = modifiedContent.replace(
          regex,
          `$1 @${priority}$2`
        );
      }
    }

    return modifiedContent;
  }

  /**
   * Generate cache key based on dependencies
   */
  private generateCacheKey(): string {
    const data = JSON.stringify({
      dependencies: this.packageJson?.dependencies || {},
      devDependencies: this.packageJson?.devDependencies || {},
      framework: this.config.framework,
      load: this.config.load,
      exclude: this.config.exclude,
      overrides: this.config.overrides,
    });

    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Load schemas from cache
   */
  private async loadFromCache(): Promise<boolean> {
    if (!this.cacheKey) return false;

    const cachePath = join(this.config.cacheDir, `${this.cacheKey}.json`);
    
    if (existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
        
        // Check cache validity (24 hours)
        const cacheAge = Date.now() - cached.timestamp;
        if (cacheAge > 24 * 60 * 60 * 1000) {
          return false;
        }

        // Load cached schemas
        for (const [key, schema] of Object.entries(cached.schemas)) {
          this.loadedSchemas.set(key, schema as LoadedSchema);
        }

        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Save schemas to cache
   */
  private async saveToCache(): Promise<void> {
    if (!this.cacheKey) return;

    const cacheDir = resolve(this.config.cacheDir);
    const cachePath = join(cacheDir, `${this.cacheKey}.json`);

    // Create cache directory if it doesn't exist
    const { mkdirSync } = await import('fs');
    mkdirSync(cacheDir, { recursive: true });

    const cacheData = {
      timestamp: Date.now(),
      schemas: Object.fromEntries(this.loadedSchemas),
    };

    const { writeFileSync } = await import('fs');
    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
  }

  /**
   * Send telemetry data
   */
  private async sendTelemetry(
    schemaName: string,
    version?: string,
    source?: string
  ): Promise<void> {
    // Implementation would send anonymous usage data
    // This helps prioritize which schemas to add/maintain
    try {
      await fetch(`${this.config.storeUrl}/api/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema: schemaName,
          version,
          source,
          framework: this.config.framework,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {
      // Ignore telemetry errors
    }
  }

  /**
   * Get all loaded schemas
   */
  getSchemas(): LoadedSchema[] {
    return Array.from(this.loadedSchemas.values())
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get merged schema content
   */
  getMergedSchema(): string {
    const schemas = this.getSchemas();
    const lines: string[] = [
      '# Environment Schema Store - Auto-generated',
      `# Generated at: ${new Date().toISOString()}`,
      `# Schemas loaded: ${schemas.map(s => s.name).join(', ')}`,
      '',
    ];

    for (const schema of schemas) {
      lines.push(`# === ${schema.name} ===`);
      if (schema.version) {
        lines.push(`# Version: ${schema.version}`);
      }
      if (schema.framework) {
        lines.push(`# Framework: ${schema.framework}`);
      }
      lines.push(`# Source: ${schema.source}`);
      lines.push('');
      lines.push(schema.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Validate environment variables against loaded schemas
   */
  async validate(env: Record<string, string | undefined>): Promise<SchemaValidationResult> {
    const errors: SchemaValidationResult['errors'] = [];
    const missing: SchemaValidationResult['missing'] = [];
    const schemas = this.getSchemas();

    // Parse schemas to extract variable definitions
    for (const schema of schemas) {
      const lines = schema.content.split('\n');
      let currentVar: {
        name?: string;
        required?: boolean;
        suggested?: boolean;
        pattern?: string;
        description?: string;
      } = {};

      for (const line of lines) {
        // Parse decorators
        if (line.startsWith('#')) {
          const decorators = line.match(/@(\w+)(?:\s+([^@]+))?/g);
          if (decorators) {
            for (const decorator of decorators) {
              const [, key, value] = decorator.match(/@(\w+)(?:\s+(.+))?/) || [];
              if (key === 'required') currentVar.required = true;
              if (key === 'suggested') currentVar.suggested = true;
              if (key === 'pattern') currentVar.pattern = value?.trim();
              if (key === 'desc') currentVar.description = value?.trim();
            }
          }
        }
        
        // Parse variable definition
        const varMatch = line.match(/^([A-Z_][A-Z0-9_]*)=/);
        if (varMatch) {
          currentVar.name = varMatch[1];
          
          // Check if variable is missing
          if (!(currentVar.name in env)) {
            if (currentVar.required || currentVar.suggested) {
              missing.push({
                variable: currentVar.name,
                required: currentVar.required || false,
                suggested: currentVar.suggested || false,
                description: currentVar.description,
              });
            }
          } else if (currentVar.pattern) {
            // Validate pattern
            const value = env[currentVar.name];
            if (value && !new RegExp(currentVar.pattern).test(value)) {
              errors.push({
                variable: currentVar.name,
                message: `Value does not match required pattern: ${currentVar.pattern}`,
                severity: 'error',
              });
            }
          }
          
          // Reset for next variable
          currentVar = {};
        }
      }
    }

    return {
      valid: errors.length === 0 && missing.filter(m => m.required).length === 0,
      errors,
      missing,
    };
  }

  /**
   * Clear the schema cache
   */
  async clearCache(): Promise<void> {
    const { rmSync } = await import('fs');
    rmSync(this.config.cacheDir, { recursive: true, force: true });
  }
}