/**
 * Catalog API
 * Returns the complete schema catalog
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import catalog from '../catalog.json';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Set cache headers for CDN
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Return the catalog
  return res.status(200).json(catalog);
}