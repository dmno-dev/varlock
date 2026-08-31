import { define } from 'gunshi';

export const commandSpec = define({
  name: 'audit',
  description: 'Audit code env var usage against your .env.schema',
  args: {
    targets: {
      type: 'positional',
      required: false,
      multiple: true,
      description: 'Directories to scan for env var references (defaults to the current project)',
    },
    path: {
      type: 'string',
      short: 'p',
      description: 'Path to a specific .env file or directory to use as the schema entry point',
    },
    ignore: {
      type: 'string',
      short: 'i',
      multiple: true,
      description: 'Directory to exclude from code scanning (can be specified multiple times)',
    },
  },
  examples: `
Scans your source code for environment variable references and compares them
to keys defined in your varlock schema.

Examples:
  varlock audit                          # Audit current project
  varlock audit --path .env.prod         # Audit using a specific env entry point
  varlock audit ./src ./lib              # Only scan specific directories
  varlock audit --ignore vendor          # Exclude a directory from scanning
  varlock audit -i vendor -i generated   # Exclude multiple directories
`.trim(),
});
