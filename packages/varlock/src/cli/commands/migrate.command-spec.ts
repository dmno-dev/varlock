import { define } from 'gunshi';

export const commandSpec = define({
  name: 'migrate',
  description: 'Re-encrypt device-encrypted values to your local identity key',
  // Hidden until the native daemons can do this on hardware backends. Today it
  // only works on the file backend, so advertising it would send most users to
  // a command that politely refuses.
  internal: true,
  args: {
    file: {
      type: 'string',
      description: 'Path to a single .env file (defaults to every env file in the loaded graph)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what would change without writing anything',
    },
    'key-id': {
      type: 'string',
      description: 'Encryption key ID',
      default: 'varlock-default',
      hidden: true,
    },
  },
  examples: `
Rewrites values encrypted directly to this device's key so they are encrypted to
your identity key instead. Values already encrypted to the identity, prompts, and
anything that is not a varlock("local:...") reference are left untouched.

Examples:
  varlock migrate                          # Migrate every env file in the graph
  varlock migrate --dry-run                # Show what would change
  varlock migrate --file .env.local        # Migrate a single file
`.trim(),
});
