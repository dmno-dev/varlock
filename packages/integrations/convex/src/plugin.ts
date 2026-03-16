/**
 * Varlock plugin for Convex integration.
 *
 * Registers the @syncTarget(convex) item decorator, which marks environment variables
 * for syncing to a Convex deployment.
 *
 * Usage in .env.schema:
 *   # @plugin(@varlock/convex-integration)
 *   DATABASE_URL=string @syncTarget(convex) @sensitive
 *   API_KEY=op("op://vault/item/key") @syncTarget(convex) @sensitive
 */

// side-effect import: declares the global `plugin` variable
import 'varlock/plugin-lib';

const CONVEX_ICON = 'simple-icons:convex';

plugin.name = 'convex';
plugin.icon = CONVEX_ICON;

const { debug } = plugin;
debug('init - version =', plugin.version);

// Register the @syncTarget(targetName) item decorator
// This is a function-style decorator: @syncTarget(convex), @syncTarget(vercel), etc.
// Multiple can be used on the same item: @syncTarget(convex) @syncTarget(vercel)
plugin.registerItemDecorator({
  name: 'syncTarget',
  isFunction: true,
  useFnArgsResolver: true,
  // No process() needed -- the resolved value of the decorator (e.g., "convex")
  // is automatically available via decorator.resolvedValue after resolution.
  // The serialization in getSerializedGraph() reads it from getDecFns('syncTarget').
});

// Register a convex deploy key data type for validation
plugin.registerDataType({
  name: 'convexDeployKey',
  typeDescription: 'A Convex deploy key',
  icon: CONVEX_ICON,
  sensitive: true,
  validate(value: string) {
    if (typeof value !== 'string') return new Error('expected a string');
    // Deploy keys have format: prod:name|token, preview:team:project|token, dev:name|token
    if (!/^(prod|preview|dev):[\w:-]+\|.+$/.test(value)) {
      return new Error('invalid Convex deploy key format (expected prod:name|token, preview:team:project|token, or dev:name|token)');
    }
    return true;
  },
  docs: [{ url: 'https://docs.convex.dev/cli/deploy-key-types', description: 'Convex deploy key types' }],
});
