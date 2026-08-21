import { isBundledSEA } from '../helpers/install-detection';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { commandSpec } from './doctor.command-spec';

export { commandSpec };

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  console.log('');
  console.log('🧙 Varlock doctor -- coming soon...');

  console.log('Bundled SEA?', isBundledSEA());

  // TODO: Mac app checks
  // - installed, running, logged in, set up (keys exist), locked/unlocked state
};

