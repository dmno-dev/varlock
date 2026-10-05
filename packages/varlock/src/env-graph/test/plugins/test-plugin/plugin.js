const { plugin } = require('varlock/plugin-lib');

plugin.icon = 'test-plugin:icon';
plugin.bundledIcons = { 'test-plugin:icon': '<svg>test</svg>' };

// one data type inherits the plugin icon, one sets its own
plugin.registerDataType({ name: 'testPluginIconless' });
plugin.registerDataType({ name: 'testPluginOwnIcon', icon: 'test-plugin:own-icon' });
// defs can also be functions of the type's args
plugin.registerDataType(() => ({ name: 'testPluginFnType' }));

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


