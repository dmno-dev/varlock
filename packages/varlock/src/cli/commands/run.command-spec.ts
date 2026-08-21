import { define } from 'gunshi';

import { REDACT_STDOUT_ARG } from '../helpers/redact-stdout-arg';

export const commandSpec = define({
  name: 'run',
  description: 'Run a command with your environment variables injected',
  args: {
    // watch: {
    //   type: 'boolean',
    //   short: 'w',
    //   description: 'Watch mode',
    // },
    ...REDACT_STDOUT_ARG,
    inject: {
      type: 'string',
      short: 'i',
      description: 'Control what gets injected into the child process env: "all" (default), "vars" (individual vars only, no blob), or "blob" (only __VARLOCK_ENV blob, no individual vars)',
    },
    'no-inject-graph': {
      type: 'boolean',
      description: 'Deprecated: use --inject vars instead',
      hidden: true,
    },
    'include-internal': {
      type: 'boolean',
      description: 'Pass @internal items through to the child process (by default they are stripped, even when set in the ambient env). Use this for a nested `varlock run` whose own resolution needs the internal value (e.g. a secret-zero token).',
    },
    filter: {
      type: 'string',
      description: 'Filter which items are injected: comma-separated key names/globs (e.g. STRIPE_*), negations (!KEY), decorator selectors (@sensitive, @required), and tag selectors (#tagname, set via @tag(tagname)). Can also be set via the _VARLOCK_FILTER env var (this flag takes precedence)',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
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
Executes a command in a child process, injecting your resolved and validated environment
variables from your .env files. Useful when a code-level integration is not possible.

Examples:
  varlock run -- node app.js                    # Run a Node.js application
  varlock run -- python script.py               # Run a Python script
  varlock run -- sh -c 'echo $MY_VAR'           # Use shell expansion for env vars
  varlock run --inject vars -- sh               # Inject only individual vars, no blob
  varlock run --inject blob -- node app.js      # Inject only the blob, no individual vars
  varlock run --path .env.prod -- node app.js   # Use a specific .env file
  varlock run --path ./config/ -- node app.js   # Use a specific directory
  varlock run -p ./envs -p ./overrides -- node app.js  # Use multiple directories
  varlock run --filter="STRIPE_*,!STRIPE_DEBUG_KEY" -- node app.js  # Only inject STRIPE_* keys, excluding one

📍 Important: Use -- to separate varlock options from your command

💡 Tip: For shell expansion of env vars, use: sh -c 'your command here'
💡 Tip: Output redaction applies automatically when output is piped/redirected (e.g., CI logs);
   interactive terminals get raw TTY pass-through, so tools like psql and claude just work.
   Use --no-redact-stdout to disable redaction for piped output, or --redact-stdout to
   force it (e.g., to override @redactLogs=false).
💡 Tip: Use --inject vars to prevent __VARLOCK_ENV from being visible in child process env
💡 Tip: Use --inject blob when your app uses the ENV proxy and doesn't need individual process.env vars
  `.trim(),
});
