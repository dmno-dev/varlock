// Legacy plugin that uses the old implicit `plugin` global (no require).
// Used to verify the migration error message is shown.
plugin.registerResolverFunction({
  name: 'legacyTest',
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
