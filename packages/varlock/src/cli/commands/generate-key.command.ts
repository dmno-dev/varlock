import { randomBytes } from 'node:crypto';

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { commandSpec } from './generate-key.command-spec';

export { commandSpec };

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const key = randomBytes(32).toString('hex');

  if (ctx.values.plain) {
    console.log(key);
    return;
  }

  console.log('');
  console.log('Generated _VARLOCK_ENV_KEY:');
  console.log('');
  console.log(`  ${key}`);
  console.log('');
  console.log('Set this as an environment variable on your deployment platform (e.g., Vercel, Cloudflare).');
  console.log('When _VARLOCK_ENV_KEY is present at build time, the resolved env blob will be');
  console.log('encrypted before being injected into the build output, and decrypted at runtime.');
  console.log('');
};
