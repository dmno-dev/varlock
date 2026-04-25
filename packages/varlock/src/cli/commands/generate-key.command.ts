import { define } from 'gunshi';

import { generateEncryptionKeyHex } from '../../runtime/crypto';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'generate-key',
  description: 'Generate an encryption key for encrypting the env blob in deployments',
  args: {},
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async () => {
  const key = generateEncryptionKeyHex();

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
