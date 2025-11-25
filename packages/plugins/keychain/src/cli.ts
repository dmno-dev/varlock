import {
  executeVarlockPluginCli,
  defineSubcommand,
  defineVarlockPluginCli,
} from 'varlock/plugin-cli-lib';

const addCommand = defineSubcommand({
  name: 'add',
  description: 'Add a value to the keychain',
  args: {
    key: { type: 'string', description: 'The key to add' },
  },
  run: (ctx) => {
    console.log('Adding a new keychain item');
  },
});


const deleteCommand = defineSubcommand({
  name: 'delete',
  description: 'Remove a value from the keychain',
  args: {
    key: { type: 'string', description: 'The key to add' },
  },
  run: (ctx) => {
    console.log('Adding a new keychain item');
  },
});

const updateCommand = defineSubcommand({
  name: 'update',
  description: 'Update a value in the keychain',
  args: {
    key: { type: 'string', description: 'The key to add' },
  },
  run: (ctx) => {
    console.log('Adding a new keychain item', ctx.args);
  },
});


// await executeVarlockPluginCli([
//   addCommand,
//   deleteCommand,
//   updateCommand,
// ]);
export default defineVarlockPluginCli(async (envGraph) => {
  const addCommand2 = defineSubcommand({
    name: 'add',
    description: 'Add a value to the keychain',
    args: {
      key: { type: 'string', description: 'The key to add' },
    },
    run: (ctx) => {
      // console.log(envGraph);

      for (const itemKey in envGraph.configSchema) {
        const item = envGraph.configSchema[itemKey];
        console.log(item.key, item.isSensitive);
        item.defs.forEach((def) => {
          console.log(def.itemDef.decorators);
        });
      }

      console.log('Adding a new keychain item');
    },
  });

  return { commands: [addCommand2] };
});
