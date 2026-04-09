import ansis from 'ansis';
import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { formattedValue, formatTimeAgo } from '../../lib/formatting';
import { redactString } from '../../runtime/lib/redaction';
import {
  checkForSchemaErrors, checkForNoEnvFiles,
} from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { StaticValueResolver } from '../../env-graph/lib/resolver';
import _ from '@env-spec/utils/my-dash';

export const commandSpec = define({
  name: 'explain',
  description: 'Show detailed information about how a config item is resolved',
  args: {
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc)',
    },
    path: {
      type: 'string',
      short: 'p',
      description: 'Path to a specific .env file or directory to use as the entry point',
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

function describeResolver(resolver: any, indent = ''): string {
  if (resolver instanceof StaticValueResolver) {
    return `${indent}static value`;
  }
  const fnName = resolver.fnName;
  if (fnName && !fnName.startsWith('\0')) {
    return `${indent}${fnName}()`;
  }
  return `${indent}(resolver)`;
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const positionals = (ctx.positionals ?? []).slice(ctx.commandPath?.length ?? 0);
  if (!positionals.length) {
    throw new CliExitError('Missing required argument: variable name', {
      suggestion: 'Run `varlock explain MY_VAR` to explain a config item',
    });
  }
  const varName = positionals[0];

  const envGraph = await loadVarlockEnvGraph({
    currentEnvFallback: ctx.values.env,
    entryFilePath: ctx.values.path,
  });

  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  if (!(varName in envGraph.configSchema)) {
    throw new CliExitError(`Variable "${varName}" not found in schema`);
  }

  await envGraph.resolveEnvValues();

  const item = envGraph.configSchema[varName];
  const isSensitive = item.isSensitive;

  // Header
  console.log('');
  console.log(ansis.bold.cyan(`  ${item.key}`));
  console.log('');

  // Description
  if (item.description) {
    console.log(`  ${ansis.gray('Description:')} ${item.description}`);
  }

  // Type info
  if (item.dataType) {
    console.log(`  ${ansis.gray('Type:')} ${item.dataType.name}`);
  }

  // Properties
  const props = [];
  if (item.isRequired) props.push('required');
  else props.push('optional');
  if (isSensitive) props.push('sensitive');
  else props.push('public');
  console.log(`  ${ansis.gray('Properties:')} ${props.join(', ')}`);

  // Resolved value
  console.log('');
  console.log(ansis.bold('  Resolved value'));
  if (item.validationState === 'error') {
    console.log(`  ${ansis.red('  (resolution failed)')}`);
    for (const err of item.errors) {
      console.log(`  ${ansis.red(`  - ${err.message}`)}`);
    }
  } else {
    let valStr = formattedValue(item.resolvedValue, true);
    if (isSensitive && item.resolvedValue && _.isString(item.resolvedValue)) {
      valStr = redactString(item.resolvedValue)!;
    }
    console.log(`    ${valStr}`);
    if (item.isCoerced) {
      let rawStr = formattedValue(item.resolvedRawValue, true);
      if (isSensitive && item.resolvedRawValue && _.isString(item.resolvedRawValue)) {
        rawStr = redactString(item.resolvedRawValue)!;
      }
      console.log(`    ${ansis.gray.italic(`coerced from ${rawStr}`)}`);
    }
  }

  // Value source
  console.log('');
  console.log(ansis.bold('  Value source'));

  if (item.isOverridden) {
    console.log(`    ${ansis.yellow('⚡ process.env override')} ${ansis.yellow.bold('(active)')}`);
    const activeValueDef = item.activeValueDef;
    if (activeValueDef) {
      const sourceLabel = activeValueDef.source?.label || 'internal';
      const resolverDesc = activeValueDef.itemDef.resolver
        ? describeResolver(activeValueDef.itemDef.resolver)
        : 'no value';
      console.log(`    ${ansis.gray('└')} ${ansis.gray.italic(`would use ${resolverDesc} from ${sourceLabel} without override`)}`);
    }
  } else {
    const activeValueDef = item.activeValueDef;
    if (activeValueDef) {
      const sourceLabel = activeValueDef.source?.label || 'internal';
      const resolverDesc = activeValueDef.itemDef.resolver
        ? describeResolver(activeValueDef.itemDef.resolver)
        : 'no value';
      console.log(`    ${resolverDesc} from ${ansis.cyan(sourceLabel)}`);
    } else {
      console.log(`    ${ansis.gray('(no value set)')}`);
    }
  }

  // Cache info
  if (item.isCached || item.isCacheHit) {
    const cacheTtl = item.cacheTtl;
    const ttlDisplay = cacheTtl !== undefined ? String(cacheTtl) : 'forever';
    console.log('');
    console.log(ansis.bold('  Cache'));
    console.log(`    ${ansis.gray('TTL:')} ${ttlDisplay}`);
    if (item.isCacheHit) {
      const oldest = Math.min(...item._cacheHits.map((h) => h.cachedAt));
      console.log(`    ${ansis.blue('Status:')} hit (cached ${formatTimeAgo(oldest)})`);
    } else {
      console.log(`    ${ansis.gray('Status:')} miss (freshly resolved)`);
    }
  }

  // All definitions
  const defs = item.defs;
  if (defs.length) {
    console.log('');
    console.log(ansis.bold('  All definitions') + ansis.gray(` (${defs.length} source${defs.length > 1 ? 's' : ''}, highest priority first)`));

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const sourceLabel = def.source?.label || 'internal (builtin)';
      const sourceType = def.source?.type || 'builtin';

      const isActiveSource = !item.isOverridden && def === item.activeValueDef;
      const marker = isActiveSource ? ansis.green(' ← active') : '';

      console.log(`    ${ansis.gray(`${i + 1}.`)} ${ansis.cyan(sourceLabel)} ${ansis.gray(`(${sourceType})`)}${marker}`);

      // Show resolver info
      if (def.itemDef.resolver) {
        console.log(`       ${ansis.gray('value:')} ${describeResolver(def.itemDef.resolver)}`);
      } else {
        console.log(`       ${ansis.gray('value:')} ${ansis.gray.italic('(none - decorators only)')}`);
      }

      // Show decorators from this definition
      const decNames = def.itemDef.decorators?.map((d) => `@${d.name}`).join(', ');
      if (decNames) {
        console.log(`       ${ansis.gray('decorators:')} ${ansis.magenta(decNames)}`);
      }
    }
  }

  // Docs links
  const docsLinks = item.docsLinks;
  if (docsLinks.length) {
    console.log('');
    console.log(ansis.bold('  Documentation'));
    for (const link of docsLinks) {
      const label = link.description ? `${link.description}: ` : '';
      console.log(`    ${label}${ansis.underline(link.url)}`);
    }
  }

  console.log('');

  if (item.validationState === 'error') {
    gracefulExit(1);
  }
};
