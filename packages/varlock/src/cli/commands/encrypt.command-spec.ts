import { define } from 'gunshi';

export const commandSpec = define({
  name: 'encrypt',
  description: 'Encrypt a value using device-local encryption',
  args: {
    format: {
      type: 'enum',
      choices: ['pretty', 'raw'],
      default: 'pretty',
      description: 'Output format for single-value mode',
    },
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
  },
  examples: `
Encrypts a value using device-local encryption (Secure Enclave / TPM / file-based),
producing a varlock("local:...") reference that is safe to commit.

Single-value mode reads from stdin (or prompts interactively) so secrets stay out of
shell history. --file mode encrypts all @sensitive plaintext values in a .env file in place.
Use --format raw to print only the varlock() value expression to stdout. Raw mode requires
a value on stdin (pipe or redirect) and does not prompt.

Examples:
  echo "$MY_SECRET" | varlock encrypt    # Encrypt a value from stdin (non-interactive, agent-friendly)
  echo "$MY_SECRET" | varlock encrypt --format raw  # Output only varlock("local:...")
  varlock encrypt                        # Prompt interactively for a value
  varlock encrypt --file .env.local      # Encrypt @sensitive plaintext values in a file in-place
`.trim(),
});
