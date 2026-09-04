const { plugin } = require('varlock/plugin-lib');

plugin.name = 'test-plugin-with-cache';

// captured during module execution, which is how real plugins (1password, aws-secrets)
// grab it - the accessor has to keep working after the graph swaps its cache store
let pluginCache;
try {
  pluginCache = plugin.cache;
} catch {
  // cache not available
}

let runCount = 0;

// resolves through the plugin cache, so two calls sharing a key return the same value
// only when the accessor is actually backed by a live store
plugin.registerResolverFunction({
  name: 'cachedRun',
  async resolve() {
    if (!pluginCache) return 'no-cache';
    return await pluginCache.getOrSet('run', '1h', async () => {
      runCount += 1;
      return `run-${runCount}`;
    });
  },
});
