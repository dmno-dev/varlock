/// <reference path="../../../../plugin-lib.ts" />

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


