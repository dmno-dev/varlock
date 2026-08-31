import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { commandSpec } from './printenv.command-spec';

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

export { commandSpec };

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
