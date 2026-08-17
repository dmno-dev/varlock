import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';

const TEMPLATE_PLACEHOLDER_REGEX = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export type TemplateEscapeLang = 'json';

export function extractTemplateKeys(template: string): Array<string> {
  const keys = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_PLACEHOLDER_REGEX)) {
    keys.add(match[1]);
  }
  return [...keys];
}

export function renderTemplate(
  template: string,
  values: Record<string, string>,
  escapeLang?: TemplateEscapeLang,
): string {
  return template.replace(TEMPLATE_PLACEHOLDER_REGEX, (_placeholder, key) => {
    const value = values[key] ?? '';
    // escapes the value's content for embedding inside a JSON string literal;
    // no quotes are added, so placeholders used as bare values pass through unchanged
    if (escapeLang === 'json') return JSON.stringify(value).slice(1, -1);
    return value;
  });
}

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

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const varName = ctx.values.key;
  const template = ctx.values.template;
  if (varName && template !== undefined) {
    throw new CliExitError('Provide either a variable name or --template, not both');
  }
  if (ctx.values.escape !== undefined && template === undefined) {
    throw new CliExitError('--escape is only valid with --template');
  }
  if (!varName && template === undefined) {
    throw new CliExitError('Missing required argument: variable name', {
      suggestion: 'Run `varlock printenv MY_VAR` to print the value of MY_VAR',
    });
  }

  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths: ctx.values.path,
    clearCache: ctx.values['clear-cache'],
    skipCache: ctx.values['skip-cache'],
  });
  checkForSchemaErrors(envGraph);

  const keys = template !== undefined ? extractTemplateKeys(template) : [varName!];

  const missingKeys = keys.filter((key) => !(key in envGraph.configSchema));
  if (missingKeys.length > 0) {
    throw new CliExitError(
      `Variable${missingKeys.length > 1 ? 's' : ''} ${missingKeys.map((key) => `"${key}"`).join(', ')} not found in schema`,
    );
  }

  // Resolve only the requested item(s) and their transitive dependencies
  for (const key of keys) {
    await envGraph.resolveItemWithDeps(key);
  }

  let hasValidationErrors = false;
  for (const key of keys) {
    const item = envGraph.configSchema[key];
    if (item.validationState === 'error') {
      hasValidationErrors = true;
      for (const err of item.errors) {
        console.error(`🚨 ${err.message}`);
      }
    }
  }
  if (hasValidationErrors) return gracefulExit(1);

  const stringValue = (key: string) => {
    const value = envGraph.configSchema[key].resolvedValue;
    return value === undefined || value === null ? '' : String(value);
  };

  if (template !== undefined) {
    console.log(renderTemplate(
      template,
      Object.fromEntries(keys.map((key) => [key, stringValue(key)])),
      // gunshi already validated the value against the enum choices
      ctx.values.escape as TemplateEscapeLang | undefined,
    ));
  } else {
    console.log(stringValue(varName!));
  }
};
