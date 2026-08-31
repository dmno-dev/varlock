import { define } from 'gunshi';

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
