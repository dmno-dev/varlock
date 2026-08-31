import { define } from 'gunshi';

export const commandSpec = define({
  name: 'explain',
  description: 'Show detailed information about how a config item is resolved',
  args: {
    key: {
      type: 'positional',
      required: false,
      description: 'Config item to explain',
    },
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc)',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
  },
  examples: `
Shows detailed information about all definitions, sources, and overrides
that feed into a single config item. Useful for debugging why a value
is not what you expect.

Examples:
  varlock explain DATABASE_URL          # Explain how DATABASE_URL is resolved
  varlock explain --env production API_KEY  # Explain in production context
`.trim(),
});
