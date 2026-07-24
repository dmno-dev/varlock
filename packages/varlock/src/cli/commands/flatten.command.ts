import { define } from 'gunshi';
import path from 'node:path';
import ansis from 'ansis';

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { flattenEnvFiles, FlattenError } from '../../lib/flatten';
import { detectWorkspaceInfo } from '../../lib/workspace-utils';

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
      description: 'Download npm plugins and copy them into the output so no runtime install is needed (for shell-less/offline/distroless runtimes)',
      default: false,
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
  varlock flatten --vendor-plugins   # also download npm plugins into the output (self-contained, no runtime install)

Typical Dockerfile usage (builder stage has the full monorepo):
  RUN cd packages/api && varlock flatten
  # final stage:
  COPY --from=builder /repo/packages/api /app
  COPY --from=builder /repo/packages/api/.env-flat/ /app/
`.trim(),
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const packageDir = process.cwd();
  const workspaceInfo = detectWorkspaceInfo({ cwd: packageDir });
  const workspaceRootPath = workspaceInfo?.rootPath || packageDir;

  if (!workspaceInfo) {
    console.log(ansis.yellow('No workspace root detected (no lockfile found) - imports reaching outside the current directory cannot be flattened'));
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
