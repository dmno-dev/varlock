import { define } from 'gunshi';
import ansis from 'ansis';
import semver from 'semver';

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { isBundledSEA } from '../helpers/install-detection';
import { fmt } from '../helpers/pretty-format';
import { downloadPluginToCache } from '../../env-graph/lib/plugins';

export const commandSpec = define({
  name: 'install-plugin',
  description: 'Download and cache a plugin from npm for use with the standalone binary',
  args: {
    plugin: {
      type: 'positional',
      description: 'Plugin to install, in the format name@version (e.g. my-plugin@1.2.3)',
    },
  },
  examples: `
Pre-downloads a plugin into the local varlock plugin cache so it is available without
needing an interactive confirmation prompt. This is useful in CI environments or any
other non-interactive workflow where the standalone binary is used.

The plugin must be specified with an exact version number.

Examples:
  varlock install-plugin my-plugin@1.2.3
  varlock install-plugin @my-scope/my-plugin@2.0.0
`.trim(),
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  if (!isBundledSEA()) {
    throw new CliExitError('This command is only available when using the standalone varlock binary', {
      suggestion: 'In a JS project, install plugins as regular dependencies using your package manager.\n'
        + `For example: ${fmt.command('add my-plugin', { jsPackageManager: true })}`,
    });
  }

  const pluginDescriptor = ctx.values.plugin as string | undefined;

  if (!pluginDescriptor) {
    throw new CliExitError('No plugin specified', {
      suggestion: 'Usage: varlock install-plugin <name@version>  (e.g. my-plugin@1.2.3)',
    });
  }

  // Parse module name and version from descriptor like `some-plugin@1.2.3` or `@scope/pkg@1.2.3`.
  // Use lastIndexOf to correctly handle scoped packages (e.g. @scope/pkg@1.2.3).
  const atLocation = pluginDescriptor.lastIndexOf('@');
  if (atLocation === -1) {
    throw new CliExitError(`Missing version in "${pluginDescriptor}"`, {
      suggestion: `Specify an exact version, e.g. \`varlock install-plugin ${pluginDescriptor}@1.2.3\``,
    });
  }

  const moduleName = pluginDescriptor.slice(0, atLocation);
  const versionDescriptor = pluginDescriptor.slice(atLocation + 1);

  if (!versionDescriptor) {
    throw new CliExitError(`Missing version in "${pluginDescriptor}"`, {
      suggestion: `Specify an exact version, e.g. \`varlock install-plugin ${moduleName}@1.2.3\``,
    });
  }

  if (!semver.valid(versionDescriptor)) {
    throw new CliExitError(`"${versionDescriptor}" is not an exact version`, {
      suggestion: `Use a fixed version number (e.g. 1.2.3), not a range. Example: \`varlock install-plugin ${moduleName}@1.2.3\``,
    });
  }

  console.log(`\n📦 Installing plugin ${ansis.bold(`${moduleName}@${versionDescriptor}`)} into local cache...\n`);

  try {
    const cachedPath = await downloadPluginToCache(moduleName, versionDescriptor);
    console.log(`✅ Plugin ${ansis.bold(`${moduleName}@${versionDescriptor}`)} installed successfully`);
    console.log(ansis.dim(`   Cached at: ${cachedPath}\n`));
  } catch (err) {
    throw new CliExitError(`Failed to install plugin "${moduleName}@${versionDescriptor}"`, {
      details: (err as Error).message,
    });
  }
};
