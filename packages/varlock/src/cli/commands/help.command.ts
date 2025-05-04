import { cli } from 'gunshi';

export const commandSpec = {
  name: 'help',
  description: 'Show help info for varlock',
  options: {},
};

export const commandFn = async (commandsArray: Array<any>) => {
  // no-op - we'll trigger help from main entry point
};
