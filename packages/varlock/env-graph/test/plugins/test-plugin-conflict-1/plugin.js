/// <reference path="../../../../src/plugin-lib.ts" />

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const PLUGIN_VERSION = plugin.version;
const { debug } = plugin;

plugin.registerResolverFunction({
  name: 'conflict',
  description: 'this will cause a name conflict between plugins',
  async resolve() { return 'foo'; },
});
