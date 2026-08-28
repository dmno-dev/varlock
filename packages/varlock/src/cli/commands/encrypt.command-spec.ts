import { define } from 'gunshi';

export const commandSpec = define({
  name: 'encrypt',
  description: 'Encrypt a value using device-local encryption',
  args: {
    'key-id': {
      type: 'string',
      description: 'Encryption key ID',
      default: 'varlock-default',
      // Hidden until multi-key round-trips: the varlock("local:...") reference does not
      // encode a keyId, and the load-time resolver always decrypts with the default key,
      // so encrypting with a non-default key produces values that cannot be loaded back.
      hidden: true,
    },
    file: {
      type: 'string',
      description: 'Path to a .env file — encrypts all sensitive plaintext values in-place',
    },
    upgrade: {
      type: 'boolean',
      description: 'Also re-encrypt already-encrypted values to the current encryption target',
      // Hidden until the native daemons can re-encrypt on hardware backends.
      // Today it only works on the file backend, so advertising it would send
      // most users to a flag that politely refuses.
      hidden: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'With --upgrade, report what would change without writing anything',
      hidden: true,
    },
  },
  examples: `
Encrypts a value using device-local encryption (Secure Enclave / TPM / file-based),
producing a varlock("local:...") reference that is safe to commit.

Single-value mode reads from stdin (or prompts interactively) so secrets stay out of
shell history. --file mode encrypts all @sensitive plaintext values in a .env file in place.

Examples:
  echo "$MY_SECRET" | varlock encrypt    # Encrypt a value from stdin (non-interactive, agent-friendly)
  varlock encrypt                        # Prompt interactively for a value
  varlock encrypt --file .env.local      # Encrypt @sensitive plaintext values in a file in-place
`.trim(),
  // NOTE: --upgrade and --dry-run are hidden while re-encryption only works on
  // the file backend, so they are deliberately left out of the examples above.
});
