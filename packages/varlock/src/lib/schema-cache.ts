import path from 'node:path';
import fs from 'node:fs/promises';
import https from 'node:https';
import crypto from 'node:crypto';
import { getUserVarlockDir } from '../../lib/user-config-dir';

// GitHub raw content base URL for the varlock repo public-schemas
const PUBLIC_SCHEMAS_GITHUB_BASE = 'https://raw.githubusercontent.com/dmno-dev/varlock/main/public-schemas';

// Default TTL for cached schemas (24 hours in milliseconds)
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SchemaCacheEntry {
  /** path within the public-schemas directory (e.g., "platforms/vercel") */
  schemaPath: string;
  /** local file name in the cache folder */
  localFileName: string;
  /** timestamp when the schema was cached */
  cachedAt: number;
  /** hash of the content for integrity checks */
  contentHash: string;
}

export interface SchemaCacheIndex {
  entries: Record<string, SchemaCacheEntry>;
}

function getSchemasCacheDir() {
  return path.join(getUserVarlockDir(), 'schemas-cache');
}

function getSchemasCacheIndexPath() {
  return path.join(getSchemasCacheDir(), 'index.json');
}

async function loadCacheIndex(): Promise<SchemaCacheIndex> {
  try {
    const raw = await fs.readFile(getSchemasCacheIndexPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { entries: {} };
  }
}

async function saveCacheIndex(index: SchemaCacheIndex) {
  const cacheDir = getSchemasCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(getSchemasCacheIndexPath(), JSON.stringify(index, null, 2));
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          fetchUrl(redirectUrl).then(resolve, reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch schema: HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Fetches a public schema file, using cache when available and fresh.
 *
 * @param schemaPath - Path within public-schemas (e.g., "platforms/vercel")
 * @returns The schema file contents
 */
export async function fetchPublicSchema(schemaPath: string): Promise<string> {
  const cacheDir = getSchemasCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });

  const index = await loadCacheIndex();
  const cached = index.entries[schemaPath];

  // Check if we have a fresh cached version
  if (cached) {
    const age = Date.now() - cached.cachedAt;
    if (age < DEFAULT_CACHE_TTL_MS) {
      const cachedFilePath = path.join(cacheDir, cached.localFileName);
      try {
        return await fs.readFile(cachedFilePath, 'utf-8');
      } catch {
        // Cache file missing, fall through to re-fetch
      }
    }
  }

  // Fetch from GitHub
  const url = `${PUBLIC_SCHEMAS_GITHUB_BASE}/${schemaPath.replace(/^\//, '')}`;
  // The actual file on disk is named .env.<name>, so we need to construct the URL properly
  // schemaPath is like "platforms/vercel" -> fetch "platforms/.env.vercel"
  const parts = schemaPath.split('/');
  const name = parts.pop()!;
  const dir = parts.join('/');
  const fileUrl = `${PUBLIC_SCHEMAS_GITHUB_BASE}/${dir}/.env.${name}`;

  const content = await fetchUrl(fileUrl);

  // Save to cache
  const contentHash = hashContent(content);
  const localFileName = `${schemaPath.replace(/\//g, '_')}_${contentHash}.env`;
  const localFilePath = path.join(cacheDir, localFileName);

  await fs.writeFile(localFilePath, content);

  // Clean up old cached file if it exists
  if (cached && cached.localFileName !== localFileName) {
    try {
      await fs.rm(path.join(cacheDir, cached.localFileName), { force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  // Update index
  index.entries[schemaPath] = {
    schemaPath,
    localFileName,
    cachedAt: Date.now(),
    contentHash,
  };
  await saveCacheIndex(index);

  return content;
}


/**
 * Clears the schemas cache directory
 */
export async function clearSchemasCache() {
  const cacheDir = getSchemasCacheDir();
  try {
    await fs.rm(cacheDir, { recursive: true, force: true });
  } catch {
    // ignore if doesn't exist
  }
}

/**
 * Clears the plugins cache directory
 */
export async function clearPluginsCache() {
  const pluginsCacheDir = path.join(getUserVarlockDir(), 'plugins-cache');
  try {
    await fs.rm(pluginsCacheDir, { recursive: true, force: true });
  } catch {
    // ignore if doesn't exist
  }
}

/**
 * Clears all caches (schemas + plugins)
 */
export async function clearAllCaches() {
  await Promise.all([
    clearSchemasCache(),
    clearPluginsCache(),
  ]);
}
