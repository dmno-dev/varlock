const { plugin, SchemaError } = require('varlock/plugin-lib');

const instances = {};

plugin.name = 'test-plugin-with-standard-vars';

plugin.standardVars = {
  initDecorator: '@initTestStdVars',
  params: {
    token: { key: 'MY_PLUGIN_TOKEN', dataType: 'myPluginToken' },
  },
};

plugin.registerRootDecorator({
  name: 'initTestStdVars',
  isFunction: true,
  useFnArgsResolver: true,
  process() {
    const id = '_default';
    if (instances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }
    instances[id] = true;
    return { id };
  },
  execute() {},
});
