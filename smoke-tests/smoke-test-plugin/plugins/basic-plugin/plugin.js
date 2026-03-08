// Minimal plugin - no imports, just registers a test() resolver
plugin.registerResolverFunction({
  name: 'test',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  process() {
    return this.arrArgs[0].staticValue;
  },
  async resolve(val) {
    return val;
  },
});
