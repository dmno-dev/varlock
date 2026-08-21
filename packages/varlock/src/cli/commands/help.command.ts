import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { commandSpec } from './help.command-spec';

export { commandSpec };

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  // no-op - we'll trigger help from main entry point
};
