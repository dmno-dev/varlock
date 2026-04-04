const { plugin, SchemaError } = require('varlock/plugin-lib');

// Module-level state to detect duplicate initialization (same as real plugins like 1password, aws-secrets)
const instances = {};

plugin.name = 'test-plugin-with-init';
plugin.registerRootDecorator({
  name: 'initTestPlugin',
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
