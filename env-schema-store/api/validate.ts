/**
 * Environment Schema Validation API
 * Validates environment variables against schemas from the store
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { EnvSchemaStore } from '../../packages/varlock/src/env-schema-store';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { env, packages, framework, overrides } = req.body;

    // Validate input
    if (!env || typeof env !== 'object') {
      return res.status(400).json({ error: 'Invalid env object' });
    }

    // Initialize schema store
    const store = new EnvSchemaStore({
      autoDiscovery: false, // We'll manually specify packages
      framework,
      load: packages || [],
      overrides: overrides || {},
      telemetry: true, // Track usage for improvement
    });

    // Create a mock package.json for discovery
    const mockPackageJson = {
      dependencies: {},
      devDependencies: {},
    };

    // Add packages to mock package.json
    if (packages && Array.isArray(packages)) {
      for (const pkg of packages) {
        const [name, version] = pkg.split('@');
        mockPackageJson.dependencies[name] = version || 'latest';
      }
    }

    // Initialize with mock data
    await store.initialize();

    // Validate environment variables
    const result = await store.validate(env);

    // Return validation results
    return res.status(200).json({
      valid: result.valid,
      errors: result.errors,
      missing: result.missing,
      schemas: store.getSchemas().map(s => ({
        name: s.name,
        version: s.version,
        framework: s.framework,
        source: s.source,
      })),
    });
  } catch (error) {
    console.error('Validation error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Example request:
 * 
 * POST /api/validate
 * {
 *   "env": {
 *     "SENTRY_DSN": "https://xxx@sentry.io/123",
 *     "STRIPE_SECRET_KEY": "sk_test_xxx"
 *   },
 *   "packages": ["sentry@8.0.0", "stripe"],
 *   "framework": "nextjs"
 * }
 * 
 * Response:
 * {
 *   "valid": false,
 *   "errors": [
 *     {
 *       "variable": "STRIPE_PUBLISHABLE_KEY",
 *       "message": "Required variable is missing",
 *       "severity": "error"
 *     }
 *   ],
 *   "missing": [
 *     {
 *       "variable": "STRIPE_PUBLISHABLE_KEY",
 *       "required": true,
 *       "description": "Stripe publishable key (client-side safe)"
 *     }
 *   ],
 *   "schemas": [
 *     { "name": "sentry", "version": "8.0.0", "framework": "nextjs", "source": "explicit" },
 *     { "name": "stripe", "version": null, "framework": "nextjs", "source": "explicit" }
 *   ]
 * }
 */