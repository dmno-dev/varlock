import path from 'node:path';
import ansis from 'ansis';

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { flattenEnvFiles, FlattenError } from '../../lib/flatten';
import { commandSpec } from './flatten.command-spec';

export { commandSpec };

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const packageDir = process.cwd();

  let result;
  try {
    result = await flattenEnvFiles({
      packageDir,
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
