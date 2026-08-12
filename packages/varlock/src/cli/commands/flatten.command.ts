import { define } from 'gunshi';
import path from 'node:path';
import fs from 'node:fs';
import ansis from 'ansis';
import { pathExistsSync } from '@env-spec/utils/fs-utils';

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { flattenEnvFiles, FlattenError } from '../../lib/flatten';
import { detectWorkspaceRoot } from '../../lib/workspace-utils';

export const commandSpec = define({
  name: 'flatten',
  description: 'Copy env files imported from outside this package into a self-contained directory, rewriting @import paths',
  args: {
    'out-dir': {
      type: 'string',
      description: 'Output directory (relative to cwd unless absolute)',
      default: '.env-flat',
    },
    'include-local': {
      type: 'boolean',
      description: 'Include .env.local / .env.*.local files (excluded by default)',
      default: false,
    },
    'vendor-plugins': {
      type: 'boolean',
      description: 'Copy npm plugins into the output so no runtime install is needed (for shell-less/offline/distroless runtimes). Uses the installed copy, downloading only if absent',
      default: false,
    },
    'workspace-root': {
      type: 'string',
      description: 'Path to the workspace/monorepo root (auto-detected by default). Imports outside of it cannot be flattened',
    },
  },
  examples: `
In a monorepo, a package's env files may @import files from sibling packages or the
workspace root. Those files are not available in contexts where only the package itself
is present, like the final stage of a Docker build.

\`varlock flatten\` copies everything reachable via @import into one self-contained
directory and rewrites the @import paths, so that directory can travel with the package.
Values are never resolved - this is a purely structural transform, safe to run in CI.

Examples:
  varlock flatten                    # flatten env files from the current directory into .env-flat/
  varlock flatten --out-dir dist/env # custom output location
  varlock flatten --include-local    # also include .env.local files (careful - these often hold secrets)
  varlock flatten --vendor-plugins   # also copy npm plugins into the output (self-contained, no runtime install)
  varlock flatten --workspace-root ../..  # set the monorepo root explicitly (when auto-detection can't)

Typical Dockerfile usage (builder stage has the full monorepo):
  RUN cd packages/api && varlock flatten
  # final stage:
  COPY --from=builder /repo/packages/api /app
  COPY --from=builder /repo/packages/api/.env-flat/ /app/
`.trim(),
});

/**
 * Resolves the workspace root that bounds which imports can be flattened - either the
 * explicit `--workspace-root` (validated) or auto-detection, which works in any language.
 * When nothing is found the package itself is used, so only its own env files are flattened.
 */
export function resolveWorkspaceRoot(opts: {
  packageDir: string,
  explicitRoot?: string,
}): { workspaceRootPath: string, source: 'explicit' | 'detected' | 'fallback', marker?: string } {
  const { packageDir } = opts;

  if (opts.explicitRoot) {
    let workspaceRootPath = path.resolve(packageDir, opts.explicitRoot);
    if (!pathExistsSync(workspaceRootPath)) {
      throw new CliExitError(`--workspace-root does not exist: ${workspaceRootPath}`);
    }
    // cwd is already symlink-resolved, so resolve the given path too before comparing them
    workspaceRootPath = fs.realpathSync(workspaceRootPath);
    const relFromRoot = path.relative(workspaceRootPath, packageDir);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      throw new CliExitError(`--workspace-root must contain the current directory: ${workspaceRootPath}`, {
        suggestion: `current directory is ${packageDir}`,
      });
    }
    return { workspaceRootPath, source: 'explicit' };
  }

  const detectedRoot = detectWorkspaceRoot({ cwd: packageDir });
  if (!detectedRoot) return { workspaceRootPath: packageDir, source: 'fallback' };
  return { workspaceRootPath: detectedRoot.rootPath, source: 'detected', marker: detectedRoot.marker };
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const packageDir = process.cwd();

  const explicitRootArg = ctx.values['workspace-root'];
  const { workspaceRootPath, source, marker } = resolveWorkspaceRoot({
    packageDir,
    explicitRoot: explicitRootArg ? String(explicitRootArg) : undefined,
  });

  if (source === 'fallback') {
    console.log(ansis.yellow('No workspace root detected (no lockfile, workspace config, or .git found) - imports reaching outside the current directory cannot be flattened'));
    console.log(ansis.gray('Pass --workspace-root <path> to set it explicitly'));
  } else {
    const how = source === 'explicit' ? '--workspace-root' : `detected via ${marker}`;
    console.log(ansis.gray(`Workspace root: ${path.relative(packageDir, workspaceRootPath) || '.'} (${how})`));
  }

  let result;
  try {
    result = await flattenEnvFiles({
      packageDir,
      workspaceRootPath,
      outDir: String(ctx.values['out-dir']),
      includeLocal: !!ctx.values['include-local'],
      vendorPlugins: !!ctx.values['vendor-plugins'],
    });
  } catch (err) {
    if (err instanceof FlattenError) throw new CliExitError(err.message);
    throw err;
  }

  const relOutDir = path.relative(packageDir, result.outDir) || '.';

  console.log(`Flattened ${result.copiedFiles.length} file${result.copiedFiles.length === 1 ? '' : 's'} into ${ansis.bold(relOutDir)}/`);
  for (const { src } of result.copiedFiles) {
    console.log(ansis.gray(`  ${path.relative(packageDir, src)}`));
  }

  if (result.pinnedPlugins.length) {
    console.log('\nPinned plugin versions (so they can auto-install without the original package present):');
    for (const p of result.pinnedPlugins) {
      console.log(ansis.gray(`  ${p.moduleName}@${p.version}`));
    }
  }

  if (result.vendoredPlugins.length) {
    console.log(`\nVendored ${result.vendoredPlugins.length} plugin${result.vendoredPlugins.length === 1 ? '' : 's'} into ${ansis.bold(`${relOutDir}/.env-plugins`)}/ (no runtime install needed):`);
    for (const p of result.vendoredPlugins) {
      console.log(ansis.gray(`  ${p.moduleName}@${p.version}`));
    }
  }

  if (result.skippedLocalFiles.length) {
    console.log(`\nSkipped ${result.skippedLocalFiles.length} local env file${result.skippedLocalFiles.length === 1 ? '' : 's'} (use --include-local to include)`);
  }

  if (result.warnings.length) {
    console.log('');
    for (const warning of result.warnings) {
      console.log(`${ansis.yellow('⚠')} ${warning}`);
    }
  }

  console.log(ansis.gray(`\nAdd ${relOutDir}/ to your .gitignore - it is a generated artifact.`));
};
