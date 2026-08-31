import { define } from 'gunshi';

export const commandSpec = define({
  name: 'plugin',
  description: 'Run a CLI command for an installed plugin',
  args: {
    pluginId: { type: 'positional', description: 'ID of the plugin to run a command for' },
    command: { type: 'positional', description: 'Command to run for the plugin' },
  },
});
