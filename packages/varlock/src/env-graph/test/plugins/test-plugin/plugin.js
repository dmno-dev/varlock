const { plugin } = require('varlock/plugin-lib');

plugin.bundledIcons = { 'test-plugin:icon': '<svg>test</svg>' };

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


