import { randomBytes } from 'node:crypto';
import { define } from 'gunshi';

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'generate-key',
  description: 'Generate an encryption key for encrypting the env blob in deployments',
  args: {
    plain: {
      type: 'boolean',
      description: 'Print only the key (for piping into other commands)',
    },
  },
  examples: `
Generates a random 256-bit hex key for \`_VARLOCK_ENV_KEY\`.

Examples:
  varlock generate-key              # Human-readable output
  varlock generate-key --plain      # Key only, for piping
  `.trim(),
});

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
