const { plugin, SchemaError } = require('varlock/plugin-lib');

// Module-level state to detect duplicate initialization (same as real plugins like 1password, aws-secrets)
const instances = {};

plugin.name = 'test-plugin-with-init';
plugin.registerRootDecorator({
  name: 'initTestPlugin',
  isFunction: true,
  useFnArgsResolver: true,
  process(argsVal) {
    const id = '_default';
    if (instances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }
    instances[id] = {};
    return { id, valueResolver: argsVal.objArgs?.value };
  },
  async execute({ id, valueResolver }) {
    // mirrors real init decorators resolving their args (ex: @initAws region/profile)
    instances[id].value = await valueResolver?.resolve();
  },
});

// exposes what the init decorator resolved so tests can assert on it
plugin.registerResolverFunction({
  name: 'initArgValue',
  resolve() {
    return instances._default?.value;
  },
});
