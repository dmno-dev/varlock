import { define } from 'gunshi';

export const commandSpec = define({
  name: 'sessions',
  description: 'List the unlock sessions the encryption daemon is currently holding',
  args: {
    json: {
      type: 'boolean',
      description: 'Print the raw session records as JSON',
    },
  },
  examples: `
Shows every live unlock session on this machine: which key each one covers, when it
was unlocked, when it expires, how many decrypts it has served, and what will end it.

Sessions are created when you approve an unlock, and one covers every value that key
protects until it expires or something locks it. Nothing here is a secret: the daemon
never reports key material.

Examples:
  varlock sessions                  # Table of live sessions
  varlock sessions --json           # Same data as JSON, for scripts
  varlock lock --current            # End the session for this terminal
  varlock lock --session <id>       # End one specific session
  varlock lock                      # End all of them
`.trim(),
});
