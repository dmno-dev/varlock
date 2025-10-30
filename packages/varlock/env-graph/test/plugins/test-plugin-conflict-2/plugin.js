/// <reference path="../../../../src/plugin-lib.ts" />

plugin.registerResolverFunction({
  name: 'conflict',
  description: 'this will cause a name conflict between plugins',
  async resolve() { return 'foo'; },
});
