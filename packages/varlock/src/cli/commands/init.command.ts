import { VARLOCK_BANNER } from '../../lib/ascii-art';

export const commandSpec = {
  name: 'init',
  description: 'Set up varlock in the current project',
  options: {

  },
};

export const commandFn = async (commandsArray: Array<any>) => {
  console.log('😈🔮🔏');
  console.log(VARLOCK_BANNER);
};
