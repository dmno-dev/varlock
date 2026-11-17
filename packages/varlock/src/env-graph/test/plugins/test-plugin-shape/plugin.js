const fs = require('node:fs');
const { plugin } = require('varlock/plugin-lib');

// no `pure` flag: has a side effect, so shape mode must not run it
plugin.registerResolverFunction({
  name: 'shapeTouch',
  argsSchema: { type: 'array', arrayExactLength: 1 },
  async resolve() {
    fs.writeFileSync(await this.arrArgs[0].resolve(), 'ran');
    return 'touched';
  },
});

// only reads its args: marked pure, so shape mode runs it
plugin.registerResolverFunction({
  name: 'shapeShout',
  pure: true,
  argsSchema: { type: 'array', arrayExactLength: 1 },
  async resolve() {
    return String(await this.arrArgs[0].resolve()).toUpperCase();
  },
});
