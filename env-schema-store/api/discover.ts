/**
 * Schema Discovery API
 * Discovers and returns relevant schemas based on package names
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import catalog from '../catalog.json';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { packages, framework } = req.query;

    // Parse packages query parameter
    const packageList = typeof packages === 'string' 
      ? packages.split(',').map(p => p.trim())
      : [];

    // Find matching schemas
    const matchedSchemas = [];

    for (const packageName of packageList) {
      // Extract version if specified
      const [name, version] = packageName.split('@');

      // Find schema in catalog
      const schema = catalog.schemas.find(s => 
        s.packageNames.includes(name) || s.name === name
      );

      if (schema) {
        // Determine the appropriate schema file
        let schemaFile = schema.schemaFile;
        
        // Check for framework-specific schema
        if (framework && typeof framework === 'string' && schema.frameworks?.[framework]) {
          schemaFile = schema.frameworks[framework].schemaFile;
        }
        
        // Check for version-specific schema
        if (version && schema.versions?.[version]) {
          schemaFile = schema.versions[version];
        }

        matchedSchemas.push({
          name: schema.name,
          displayName: schema.displayName,
          description: schema.description,
          category: schema.category,
          url: schema.url,
          schemaFile,
          packageName: name,
          requestedVersion: version,
          framework: framework || null,
          envPrefix: framework && schema.frameworks?.[framework as string]?.envPrefix || null,
        });
      }
    }

    // Return discovered schemas
    return res.status(200).json({
      packages: packageList,
      framework: framework || null,
      schemas: matchedSchemas,
      categories: catalog.categories,
    });
  } catch (error) {
    console.error('Discovery error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Example request:
 * GET /api/discover?packages=sentry,stripe,prisma&framework=nextjs
 * 
 * Response:
 * {
 *   "packages": ["sentry", "stripe", "prisma"],
 *   "framework": "nextjs",
 *   "schemas": [
 *     {
 *       "name": "sentry",
 *       "displayName": "Sentry",
 *       "description": "Error tracking and performance monitoring",
 *       "category": "monitoring",
 *       "url": "https://sentry.io",
 *       "schemaFile": "schemas/monitoring/sentry-nextjs.env.schema",
 *       "packageName": "sentry",
 *       "requestedVersion": null,
 *       "framework": "nextjs",
 *       "envPrefix": ["NEXT_PUBLIC_", ""]
 *     },
 *     {
 *       "name": "stripe",
 *       "displayName": "Stripe",
 *       "description": "Payment processing platform",
 *       "category": "payments",
 *       "url": "https://stripe.com",
 *       "schemaFile": "schemas/payments/stripe.env.schema",
 *       "packageName": "stripe",
 *       "requestedVersion": null,
 *       "framework": "nextjs",
 *       "envPrefix": null
 *     },
 *     {
 *       "name": "prisma",
 *       "displayName": "Prisma",
 *       "description": "Next-generation Node.js and TypeScript ORM",
 *       "category": "database",
 *       "url": "https://prisma.io",
 *       "schemaFile": "schemas/database/prisma.env.schema",
 *       "packageName": "prisma",
 *       "requestedVersion": null,
 *       "framework": "nextjs",
 *       "envPrefix": null
 *     }
 *   ],
 *   "categories": {
 *     "monitoring": "Monitoring & Analytics",
 *     "payments": "Payment Processing",
 *     "database": "Databases & ORMs"
 *   }
 * }
 */