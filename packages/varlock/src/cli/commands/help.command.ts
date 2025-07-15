import { define } from 'gunshi';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'help',
  description: 'Show help info for varlock',
  args: {},
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  // no-op - we'll trigger help from main entry point
};
