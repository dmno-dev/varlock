const { plugin } = require('varlock/plugin-lib');

// helper the chunk reads back from the entry (like rolldown's runtime helpers)
exports.formatValue = (val) => `chunk:${val}`;

plugin.registerResolverFunction({
  name: 'chunked',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  process() {
    return this.arrArgs[0].staticValue;
  },
  async resolve(val) {
    // lazily loaded chunk, required after the plugin module has finished executing
    return require('./chunk.cjs').run(val);
  },
});
