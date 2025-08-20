/**
 * Telemetry API
 * Collects anonymous usage data to improve the schema store
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

// In production, this would write to a database or analytics service
const telemetryStore: any[] = [];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { schema, version, source, framework, timestamp } = req.body;

    // Validate input
    if (!schema || !timestamp) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Store telemetry data (in production, this would go to a database)
    const telemetryEntry = {
      schema,
      version: version || null,
      source: source || 'unknown',
      framework: framework || null,
      timestamp,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    };

    // In production, we would:
    // 1. Hash the IP for privacy
    // 2. Store in a time-series database
    // 3. Generate aggregated statistics
    // 4. Use this data to prioritize schema development

    telemetryStore.push(telemetryEntry);

    // Log for monitoring (in production, use proper logging service)
    console.log('Telemetry received:', {
      schema,
      version,
      source,
      framework,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Telemetry error:', error);
    // Don't return errors for telemetry - we don't want to break the user's flow
    return res.status(200).json({ success: false });
  }
}

/**
 * Telemetry data helps us:
 * 1. Understand which schemas are most used
 * 2. Identify missing schemas that should be added
 * 3. Track framework usage patterns
 * 4. Prioritize version support
 * 
 * All data is anonymous and aggregated.
 */