// Resolver whose promise never settles - the CLI must fail rather than silently exit 0 (#1186)
const { plugin } = require('varlock/plugin-lib');

plugin.registerResolverFunction({
  name: 'neverSettles',
  argsSchema: {
    type: 'array',
    arrayMaxLength: 0,
  },
  async resolve() {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return new Promise(() => {});
  },
});
