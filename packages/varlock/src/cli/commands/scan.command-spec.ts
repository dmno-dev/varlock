import { define } from 'gunshi';

export const commandSpec = define({
  name: 'scan',
  description: 'Scan files for sensitive config values that should not be in plaintext',
  args: {
    targets: {
      type: 'positional',
      required: false,
      multiple: true,
      description: 'Files, directories, or globs to scan (defaults to the current directory)',
    },
    staged: {
      type: 'boolean',
      description: 'Only scan staged git files',
    },
    'include-ignored': {
      type: 'boolean',
      description: 'Include git-ignored files in the scan',
    },
    'install-hook': {
      type: 'boolean',
      description: 'Set up varlock scan as a git pre-commit hook',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file (e.g. .env.prod) or directory ending with "/" to use as the schema entry point (can be specified multiple times)',
    },
  },
  examples: `
Loads your varlock config, resolves all sensitive values, then scans files to
ensure none of those sensitive values appear in plaintext.

Examples:
  varlock scan                    # Scan non-git-ignored files in current directory
  varlock scan --staged           # Only scan staged git files
  varlock scan --include-ignored  # Scan all files, including git-ignored ones
  varlock scan --path .env.prod   # Use a specific .env file as the schema entry point
  varlock scan -p ./envs -p ./overrides  # Use multiple schema entry points
  varlock scan --install-hook     # Set up as a git pre-commit hook
  varlock scan ./dist             # Scan a specific directory (e.g. a build output folder)
  varlock scan ./dist ./public    # Scan multiple directories
  varlock scan './dist/**/*.js'   # Scan files matching a glob pattern
  `.trim(),
});
