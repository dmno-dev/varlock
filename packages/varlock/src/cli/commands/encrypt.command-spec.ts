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
    },
    'dry-run': {
      type: 'boolean',
      description: 'With --upgrade, report what would change without writing anything',
    },
  },
  examples: `
Encrypts a value using device-local encryption (Secure Enclave / TPM / file-based),
producing a varlock("local:...") reference that is safe to commit.

Single-value mode reads from stdin (or prompts interactively) so secrets stay out of
shell history. --file mode encrypts all @sensitive plaintext values in a .env file in place.

--upgrade re-encrypts values that are already encrypted, moving them to the current
encryption target. Use it to migrate older device-encrypted values onto an identity key,
which is what lets one unlock cover a whole session instead of prompting repeatedly.
Existing values keep working either way, so this is a migration you can take when you
want it. With no --file it covers every env file in the graph.

Examples:
  echo "$MY_SECRET" | varlock encrypt    # Encrypt a value from stdin (non-interactive, agent-friendly)
  varlock encrypt                        # Prompt interactively for a value
  varlock encrypt --file .env.local      # Encrypt @sensitive plaintext values in a file in-place
  varlock encrypt --upgrade --dry-run    # Report which values would be re-encrypted
  varlock encrypt --upgrade              # Re-encrypt them to the current target
`.trim(),
});
