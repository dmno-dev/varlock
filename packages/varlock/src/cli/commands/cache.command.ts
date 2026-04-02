import { define } from 'gunshi';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { clearSchemasCache, clearPluginsCache, clearAllCaches } from '../../lib/schema-cache';

export const commandSpec = define({
  name: 'cache',
  description: 'Manage cached schemas and plugins',
  args: {
    action: {
      type: 'positional',
      description: '"clear" to clear all caches',
    },
    target: {
      type: 'positional',
      description: '"schemas", "plugins", or "all" (default: all)',
    },
  },
  examples: `
Manage cached data for remote schemas and downloaded plugins.

Examples:
  varlock cache clear            # Clear all caches (schemas + plugins)
  varlock cache clear schemas    # Clear only the schemas cache
  varlock cache clear plugins    # Clear only the plugins cache
  `.trim(),
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const { action, target } = ctx.values;

  if (action !== 'clear') {
    throw new CliExitError('First argument must be "clear"', {
      forceExit: true,
    });
  }

  const cacheTarget = target || 'all';
  if (!['schemas', 'plugins', 'all'].includes(cacheTarget)) {
    throw new CliExitError('Cache target must be "schemas", "plugins", or "all"', {
      forceExit: true,
    });
  }

  try {
    if (cacheTarget === 'schemas') {
      await clearSchemasCache();
      console.log('✅ Schemas cache cleared');
    } else if (cacheTarget === 'plugins') {
      await clearPluginsCache();
      console.log('✅ Plugins cache cleared');
    } else {
      await clearAllCaches();
      console.log('✅ All caches cleared (schemas + plugins)');
    }
  } catch (error) {
    console.error('Failed to clear cache:', error);
    throw new CliExitError(`Failed to clear ${cacheTarget} cache`, { forceExit: true });
  }
};
