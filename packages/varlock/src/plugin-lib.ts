import type { VarlockPlugin } from './env-graph/lib/plugins';
import { pluginProxy } from './plugin-context';

export type { Resolver } from './env-graph/lib/resolver';
export type { PluginCacheAccessor } from './lib/cache/plugin-cache-accessor';
export { parseTtl } from './lib/cache/ttl-parser';
export { createDebug, type Debugger } from './lib/debug';

// Error classes exported directly so plugin authors can import them without
// going through plugin.ERRORS. ESM module caching guarantees the same class
// instance as what varlock uses internally, so instanceof checks work correctly.
export {
  ValidationError, CoercionError, SchemaError, ResolutionError,
} from './env-graph/lib/errors';

/**
 * The current plugin instance, available as a module import rather than a global.
 * Valid during plugin module execution; throws if accessed outside that window.
 *
 * Usage in a plugin:
 *   import { plugin } from 'varlock/plugin-lib';
 *   plugin.name = 'my-plugin';
 *   plugin.registerResolverFunction({ ... });
 */
export const plugin: VarlockPlugin = pluginProxy;
