const { plugin, SchemaError } = require('varlock/plugin-lib');

// mirrors the shape of real plugins (aws-secrets, 1password, ...) - an init root decorator
// whose args reference config items, and a resolver fn that uses what init resolved
const instances = {};

plugin.name = 'test-plugin-init-args';

plugin.registerRootDecorator({
  name: 'initTestArgs',
  isFunction: true,
  process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected some args');
    const id = '_default';
    if (instances[id]) throw new SchemaError(`Instance with id "${id}" already initialized`);
    instances[id] = {};
    return { id, valueResolver: objArgs.value };
  },
  async execute({ id, valueResolver }) {
    instances[id].value = await valueResolver?.resolve();
  },
});

plugin.registerResolverFunction({
  name: 'initArgValue',
  resolve() {
    return instances._default?.value;
  },
});
