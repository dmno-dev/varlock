import { define } from 'gunshi';
import { isBundledSEA } from '../helpers/install-detection';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'doctor',
  description: 'Debug and diagnose issues with your env file(s) and system',
  args: {},
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  console.log('');
  console.log('🧙 Varlock doctor -- coming soon...');

  console.log('Bundled SEA?', isBundledSEA());

  // TODO: Mac app checks
  // - installed, running, logged in, set up (keys exist), locked/unlocked state
};

