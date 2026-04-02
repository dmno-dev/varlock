import path from 'node:path';
import fs from 'node:fs/promises';
import { pathExists } from '@env-spec/utils/fs-utils';
import { getWorkspaceInfo } from '../../lib/workspace-utils';

// Lazy import to avoid circular dependency
import type { FileBasedDataSource, EnvGraphDataSource } from './data-source';

/**
 * Finds the schema file in a plugin package.
 *
 * Checks:
 * 1. "env-schema" field in package.json (points to a file relative to package root)
 * 2. .env.schema file in the package root
 */
async function findPluginSchemaFile(packageDir: string): Promise<string | undefined> {
  const pkgJsonPath = path.join(packageDir, 'package.json');

  try {
    const pkgJsonContent = await fs.readFile(pkgJsonPath, 'utf-8');
    const pkgJson = JSON.parse(pkgJsonContent);

    // Check for explicit "env-schema" field
    if (pkgJson['env-schema']) {
      const schemaFilePath = path.resolve(packageDir, pkgJson['env-schema']);
      if (await pathExists(schemaFilePath)) {
        return schemaFilePath;
      }
    }
  } catch {
    // No package.json or couldn't read it
  }

  // Fallback: look for .env.schema in the package root
  const defaultSchemaPath = path.join(packageDir, '.env.schema');
  if (await pathExists(defaultSchemaPath)) {
    return defaultSchemaPath;
  }

  return undefined;
}

/**
 * Resolves a schema file (.env.schema) from an installed plugin package.
 *
 * Looks for a schema file exported via the "env-schema" field in the plugin's package.json,
 * falling back to looking for a `.env.schema` file in the package root.
 *
 * @param pluginName - The npm package name (e.g., "@varlock/1password-plugin")
 * @param fileDataSource - The data source from which the import was triggered (for resolving node_modules)
 * @returns A DotEnvFileDataSource for the schema, or undefined if no schema found
 */
export async function resolvePluginSchema(
  pluginName: string,
  fileDataSource?: FileBasedDataSource,
): Promise<EnvGraphDataSource | undefined> {
  // Lazy import to avoid circular dependency at module level
  const { DotEnvFileDataSource } = await import('./data-source');

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
    const candidatePath = path.join(currentDir, 'node_modules', pluginName);
    if (await pathExists(candidatePath)) {
      // Found the plugin package - look for its schema
      const schemaPath = await findPluginSchemaFile(candidatePath);
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

  throw new Error(`Plugin package "${pluginName}" not found in node_modules`);
}
