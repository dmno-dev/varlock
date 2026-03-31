const { plugin } = require('varlock/plugin-lib');

plugin.registerResolverFunction({
  name: 'noop',
  description: 'not used, but wanted the plugin to not be empty',
  async resolve() { return undefined; },
});
