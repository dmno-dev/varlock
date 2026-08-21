import { define } from 'gunshi';

export const commandSpec = define({
  name: 'load',
  description: 'Load env according to schema and resolve values',
  args: {
    format: {
      type: 'enum',
      short: 'f',
      choices: ['pretty', 'json', 'env', 'shell', 'json-full'],
      description: 'Format of output',
      default: 'pretty',
    },
    agent: {
      type: 'boolean',
      description: 'Agent-safe mode: redact sensitive values (defaults to JSON format if --format is not set)',
    },
    compact: {
      type: 'boolean',
      description: 'Use compact format (for json-full: no indentation, for env/shell: skip undefined values)',
    },
    'show-all': {
      type: 'boolean',
      description: 'When load is failing, show all items rather than only failing items',
    },
    'include-internal': {
      type: 'boolean',
      description: 'Include @internal items in --format json-full output (excluded by default, since json-full is commonly consumed programmatically - e.g. by framework integrations - not just for local human inspection)',
    },
    filter: {
      type: 'string',
      description: 'Filter which items are shown: comma-separated key names/globs (e.g. STRIPE_*), negations (!KEY), decorator selectors (@sensitive, @required), and tag selectors (#tagname, set via @tag(tagname)). Can also be set via the _VARLOCK_FILTER env var (this flag takes precedence)',
    },
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc) - will be overridden by @currentEnv in the schema if present',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
    'summary-stderr': {
      type: 'boolean',
      description: 'Also output the pretty (redacted) summary to stderr (useful alongside --format json-full to get both machine-readable output on stdout and a human-readable summary on stderr)',
    },
    'summary-file': {
      type: 'string',
      description: 'Also write the pretty (redacted) summary to a file path (useful for CI, e.g. $GITHUB_STEP_SUMMARY)',
    },
    'clear-cache': {
      type: 'boolean',
      description: 'Clear cache and re-resolve all values',
    },
    'skip-cache': {
      type: 'boolean',
      description: 'Skip cache entirely for this invocation',
    },
  },
  examples: `
Loads and validates environment variables according to your .env files, and prints the results.
Useful for debugging locally, and in CI to print out a summary of env vars.

Examples:
  varlock load                    # Load and validate with pretty output
  varlock load --format json      # Output in JSON format
  eval "$(varlock load --format shell)"  # Load vars into current shell (useful with direnv)
  varlock load --show-all         # Show all items when validation fails
  varlock load --path .env.prod   # Load from a specific .env file
  varlock load -p ./envs -p ./overrides  # Load from multiple directories
  varlock load --compact          # Use compact format - skips undefined values, no indentation for json-full
  varlock load --env production   # Load for a specific environment (⚠️ ignored if using @currentEnv!)
  varlock load --format json-full --summary-stderr   # JSON on stdout + redacted human summary on stderr
  varlock load --format json-full --summary-file /tmp/summary.txt   # JSON on stdout + redacted human summary written to file
  varlock load --agent            # Agent-safe JSON output with sensitive values redacted
  varlock load --format json-full --include-internal   # Include @internal items for local debugging
  varlock load --filter="STRIPE_*,!STRIPE_DEBUG_KEY"  # Only STRIPE_* keys, excluding one
  varlock load --filter="@sensitive"  # Only items marked @sensitive
  varlock load --filter="#billing"    # Only items tagged @tag(billing)
`.trim(),
});
