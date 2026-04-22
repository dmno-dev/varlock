/**
 * Resolves `workspace:` and `catalog:` version protocols in all workspace package.json files.
 *
 * This is needed for pkg-pr-new preview releases, which call `npm publish` under the hood
 * and npm doesn't understand these protocols.
 *
 * - `workspace:*` → resolved version (e.g. "0.3.0")
 * - `workspace:^` → `^{version}` (e.g. "^0.3.0")
 * - `workspace:~` → `~{version}` (e.g. "~0.3.0")
 * - `catalog:` or `catalog:default` → version from root package.json `catalog` field
 * - `catalog:{name}` → version from root package.json `catalogs.{name}` field
 */
import fs from 'node:fs';
import path from 'node:path';
import { listWorkspaces } from './list-workspaces.ts';

const dryRun = process.argv.includes('--dry-run');
const monorepoRoot = path.resolve(import.meta.dirname, '..');

// Load root package.json to get catalog definitions
const rootPkgJson = JSON.parse(fs.readFileSync(path.join(monorepoRoot, 'package.json'), 'utf-8'));

// Build catalog lookup: { catalogName: { packageName: version } }
// `catalog:` (no name) or `catalog:default` maps to root `catalog` field
// `catalog:{name}` maps to root `catalogs.{name}` field
const catalogs: Record<string, Record<string, string>> = {};
if (rootPkgJson.catalog) {
  catalogs.default = rootPkgJson.catalog;
}
if (rootPkgJson.catalogs) {
  for (const [name, entries] of Object.entries(rootPkgJson.catalogs)) {
    catalogs[name] = entries as Record<string, string>;
  }
}

// Build workspace version lookup: { packageName: version }
const workspaces = await listWorkspaces(monorepoRoot);
const workspaceVersions: Record<string, string> = {};
for (const ws of workspaces) {
  workspaceVersions[ws.name] = ws.version;
}

const DEP_TYPES = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const;

let totalResolved = 0;

for (const ws of workspaces) {
  const pkgJsonPath = path.join(ws.path, 'package.json');
  const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
  const pkgJson = JSON.parse(raw);

  // skip private packages - they don't get published
  if (pkgJson.private) continue;

  let modified = false;

  for (const depType of DEP_TYPES) {
    const deps = pkgJson[depType];
    if (!deps) continue;

    for (const [depName, depVersion] of Object.entries(deps) as Array<[string, string]>) {
      if (typeof depVersion !== 'string') continue;

      let resolved: string | undefined;

      // Handle workspace: protocol
      if (depVersion.startsWith('workspace:')) {
        const range = depVersion.slice('workspace:'.length);
        const actualVersion = workspaceVersions[depName];
        if (!actualVersion) {
          console.error(`ERROR: Cannot resolve ${depType}.${depName}: "${depVersion}" - package not found in workspace`);
          process.exit(1);
        }

        if (range === '*') {
          resolved = actualVersion;
        } else if (range === '^') {
          resolved = `^${actualVersion}`;
        } else if (range === '~') {
          resolved = `~${actualVersion}`;
        } else {
          // For workspace:^1.0.0 style ranges, keep the semver range as-is
          resolved = range;
        }
      }

      // Handle catalog: protocol
      if (depVersion.startsWith('catalog:')) {
        const catalogName = depVersion.slice('catalog:'.length) || 'default';
        const catalog = catalogs[catalogName];
        if (!catalog) {
          console.error(`ERROR: Cannot resolve ${depType}.${depName}: "${depVersion}" - catalog "${catalogName}" not found`);
          process.exit(1);
        }
        const catalogVersion = catalog[depName];
        if (!catalogVersion) {
          console.error(`ERROR: Cannot resolve ${depType}.${depName}: "${depVersion}" - package not found in catalog "${catalogName}"`);
          process.exit(1);
        }
        resolved = catalogVersion;
      }

      if (resolved !== undefined) {
        console.log(`  ${pkgJson.name}: ${depType}.${depName} "${depVersion}" → "${resolved}"`);
        deps[depName] = resolved;
        modified = true;
        totalResolved++;
      }
    }
  }

  if (modified && !dryRun) {
    // Preserve original formatting (indentation) by detecting it from the raw file
    const indent = raw.match(/^(\s+)/m)?.[1] || '  ';
    fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, indent)}\n`);
  }
}

if (totalResolved > 0) {
  console.log(`\n✓ ${dryRun ? '[DRY RUN] Would resolve' : 'Resolved'} ${totalResolved} workspace/catalog version(s)`);
} else {
  console.log('No workspace: or catalog: versions found in publishable packages');
}
