import path from 'node:path';
import fs from 'node:fs/promises';
import { pathExists } from '@env-spec/utils/fs-utils';
import { getWorkspaceInfo } from '../../lib/workspace-utils';

// Lazy import to avoid circular dependency
import type { FileBasedDataSource, EnvGraphDataSource } from './data-source';

/**
 * Finds a specific file in a plugin package by checking the exports map.
 *
 * Looks for a `.env.schema` export (or the given subpath) in the plugin's
 * `package.json` exports field, then falls back to checking the file on disk.
 *
 * @param packageDir - Absolute path to the plugin package root
 * @param filePath - The file subpath to look for (e.g., `.env.schema` or `.env.custom`)
 */
async function findPluginSchemaFile(
  packageDir: string,
  filePath: string,
): Promise<string | undefined> {
  const pkgJsonPath = path.join(packageDir, 'package.json');

  try {
    const pkgJsonContent = await fs.readFile(pkgJsonPath, 'utf-8');
    const pkgJson = JSON.parse(pkgJsonContent);

    // Check for the file in the exports map (e.g., "./.env.schema": "./dist/.env.schema")
    const exportKey = `./${filePath}`;
    if (pkgJson.exports?.[exportKey]) {
      const exportTarget = pkgJson.exports[exportKey];
      // exports can be a string or { default: string }
      const resolvedExport = typeof exportTarget === 'string'
        ? exportTarget
        : exportTarget?.default;
      if (resolvedExport) {
        const schemaFilePath = path.resolve(packageDir, resolvedExport);
        if (await pathExists(schemaFilePath)) {
          return schemaFilePath;
        }
      }
    }
  } catch {
    // No package.json or couldn't read it
  }

  // Fallback: look for the file directly in the package root
  const defaultSchemaPath = path.join(packageDir, filePath);
  if (await pathExists(defaultSchemaPath)) {
    return defaultSchemaPath;
  }

  return undefined;
}

/**
 * Parses the plugin-schema import descriptor into a package name and optional file path.
 *
 * Supports:
 * - `@varlock/1password-plugin` → package `@varlock/1password-plugin`, file `.env.schema`
 * - `@varlock/1password-plugin/.env.custom` → package `@varlock/1password-plugin`, file `.env.custom`
 * - `my-plugin` → package `my-plugin`, file `.env.schema`
 * - `my-plugin/.env.extra` → package `my-plugin`, file `.env.extra`
 */
function parsePluginSchemaDescriptor(descriptor: string): { packageName: string; filePath: string } {
  // For scoped packages (@org/name), the package name includes the first two segments
  if (descriptor.startsWith('@')) {
    // @org/name or @org/name/.env.something
    const firstSlash = descriptor.indexOf('/');
    if (firstSlash === -1) {
      throw new Error(`Invalid scoped package name: ${descriptor}`);
    }
    const secondSlash = descriptor.indexOf('/', firstSlash + 1);
    if (secondSlash === -1) {
      // Just @org/name — no file path
      return { packageName: descriptor, filePath: '.env.schema' };
    }
    return {
      packageName: descriptor.slice(0, secondSlash),
      filePath: descriptor.slice(secondSlash + 1),
    };
  }

  // Unscoped: name or name/.env.something
  const firstSlash = descriptor.indexOf('/');
  if (firstSlash === -1) {
    return { packageName: descriptor, filePath: '.env.schema' };
  }
  return {
    packageName: descriptor.slice(0, firstSlash),
    filePath: descriptor.slice(firstSlash + 1),
  };
}

/**
 * Resolves a schema file from an installed plugin package.
 *
 * Looks for the requested file via the plugin's `package.json` exports map,
 * falling back to looking for the file directly on disk in the package root.
 *
 * The descriptor can be just a package name (defaults to `.env.schema`) or
 * a package name with a specific file path (e.g., `@varlock/1password-plugin/.env.custom`).
 *
 * @param descriptor - Package name with optional file path
 * @param fileDataSource - The data source from which the import was triggered (for resolving node_modules)
 * @returns A DotEnvFileDataSource for the schema, or undefined if no schema found
 */
export async function resolvePluginSchema(
  descriptor: string,
  fileDataSource?: FileBasedDataSource,
): Promise<EnvGraphDataSource | undefined> {
  // Lazy import to avoid circular dependency at module level
  const { DotEnvFileDataSource } = await import('./data-source');

  const { packageName, filePath } = parsePluginSchemaDescriptor(descriptor);

  const workspaceRootPath = getWorkspaceInfo()?.rootPath;

  // Start from the file data source's directory, or cwd
  let startDir: string;
  if (fileDataSource) {
    startDir = path.dirname(fileDataSource.fullPath);
  } else {
    startDir = process.cwd();
  }

  // Walk up the directory tree looking for the plugin in node_modules
  let currentDir = startDir;
  while (currentDir) {
    const candidatePath = path.join(currentDir, 'node_modules', packageName);
    if (await pathExists(candidatePath)) {
      // Found the plugin package - look for its schema file
      const schemaPath = await findPluginSchemaFile(candidatePath, filePath);
      if (schemaPath) {
        return new DotEnvFileDataSource(schemaPath);
      }
      return undefined;
    }

    // Stop at the workspace root
    if (workspaceRootPath && currentDir === workspaceRootPath) break;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  throw new Error(`Plugin package "${packageName}" not found in node_modules`);
}
