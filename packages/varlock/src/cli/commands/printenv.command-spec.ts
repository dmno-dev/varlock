import { define } from 'gunshi';

export const commandSpec = define({
  name: 'printenv',
  description: 'Print the resolved value of a single environment variable',
  args: {
    key: {
      type: 'positional',
      required: false,
      description: 'Variable to print',
    },
    template: {
      type: 'string',
      short: 't',
      description: 'Print a rendered string template instead of a single value; {{KEY}} placeholders are replaced with resolved values',
    },
    escape: {
      type: 'enum',
      choices: ['json'],
      description: 'Escape substituted values for the given language (only valid with --template); "json" escapes each value for embedding inside a JSON string literal',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory (with trailing slash) to use as the entry point (can be specified multiple times)',
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
Prints the resolved value of a single environment variable, or a rendered string
template referencing multiple variables.
Useful within larger shell commands where you need a single env var value.

Examples:
  varlock printenv MY_VAR                    # Print the value of MY_VAR
  varlock printenv --path .env.prod MY_VAR   # Use a specific .env file
  varlock printenv --path ./config/ MY_VAR   # Use a specific directory
  varlock printenv -p ./envs -p ./overrides MY_VAR  # Use multiple directories
  varlock printenv --template '{"Authorization": "Bearer {{MY_TOKEN}}"}' --escape json  # Render a template

📍 Note: Use sh -c to embed this in shell commands, e.g.:
       sh -c 'do-something --token $(varlock printenv MY_TOKEN)'

💡 Tip: Unlike \`varlock run -- echo $MY_VAR\`, this works because the shell
       expansion happens after varlock has printed the value.

💡 Tip: Use --escape json when a template emits JSON (e.g. headers for an MCP
       headersHelper) so values cannot break out of their string literals
  `.trim(),
});
