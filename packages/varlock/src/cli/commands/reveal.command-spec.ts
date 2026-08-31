import { define } from 'gunshi';

export const commandSpec = define({
  name: 'reveal',
  description: 'Securely view decrypted values of sensitive environment variables',
  args: {
    key: {
      type: 'positional',
      required: false,
      description: 'Variable to reveal (omit for an interactive picker)',
    },
    copy: {
      type: 'boolean',
      description: 'Copy the value to clipboard instead of displaying (auto-clears after 10s)',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc)',
    },
  },
  examples: `
Securely view the plaintext value of sensitive environment variables.
Values are shown in an alternate screen buffer so they don't persist in
terminal scrollback history.

Examples:
  varlock reveal                  # Interactive picker to select and reveal values
  varlock reveal MY_SECRET        # Reveal a specific variable
  varlock reveal MY_SECRET --copy # Copy value to clipboard (auto-clears after 10s)
`.trim(),
});
