import ansis from 'ansis';
import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { formattedValue, formatTimeAgo, formatDuration } from '../../lib/formatting';
import { redactString } from '../../runtime/lib/redaction';
import {
  checkForSchemaErrors, checkForNoEnvFiles,
} from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { StaticValueResolver } from '../../env-graph/lib/resolver';
import type { ConfigItem } from '../../env-graph/lib/config-item';
import _ from '@env-spec/utils/my-dash';

/** Human-readable explanation of how an item's sensitivity was determined */
function describeSensitiveSource(item: ConfigItem): string {
  switch (item.sensitiveSource) {
    case 'explicit': return 'set explicitly';
    case 'data-type': return `from the \`${item.dataType?.name}\` data type`;
    case 'resolver': return `inferred from the ${item.valueResolver?.fnName}() resolver`;
    case 'default-decorator': return 'from @defaultSensitive';
    case 'prefix': return 'from a @defaultSensitive prefix rule';
    case 'proxy': return 'forced sensitive by its @proxy rule, so the agent only sees a placeholder';
    default: return 'default: items are sensitive unless marked @public';
  }
}

/** Human-readable explanation of how an item became @internal */
function describeInternalSource(item: ConfigItem): string {
  return item.internalSource === 'explicit'
    ? 'set explicitly via @internal'
    : `set by the \`${item.dataType?.name}\` data type`;
}

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
  const varName = ctx.values.key;
  if (!varName) {
    throw new CliExitError('Missing required argument: variable name', {
      suggestion: 'Run `varlock explain MY_VAR` to explain a config item',
    });
  }

  const envGraph = await loadVarlockEnvGraph({
    currentEnvFallback: ctx.values.env,
    entryFilePaths: ctx.values.path,
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
  if (item.isInternal) props.push('internal');
  console.log(`  ${ansis.gray('Properties:')} ${props.join(', ')}`);

  // Show *how* sensitivity / internal-ness were determined (explicit vs implied by data type/resolver)
  if (isSensitive) {
    console.log(`  ${ansis.gray('Sensitive:')} yes ${ansis.gray.italic(`(${describeSensitiveSource(item)})`)}`);
  }
  if (item.isInternal) {
    console.log(`  ${ansis.gray('Internal:')} ${ansis.yellow('yes')} ${ansis.gray.italic(`(${describeInternalSource(item)} — not injected into your app; set @internal=false to inject)`)}`);
  }

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
    console.log('');
    console.log(ansis.bold('  Cache'));

    if (item.isCacheHit) {
      const hit = item._cacheHits[0];
      const ttlMs = hit.expiresAt - hit.cachedAt;
      // ~100 years is our sentinel for "forever"
      const ttlDisplay = ttlMs > 50 * 365.25 * 86_400_000 ? 'forever' : formatDuration(ttlMs);
      console.log(`    ${ansis.gray('TTL:')} ${ttlDisplay}`);
      console.log(`    ${ansis.blue('Status:')} hit (cached ${formatTimeAgo(hit.cachedAt)})`);
    } else {
      // cache miss — show TTL from the cache() resolver if available
      const cacheTtl = item.cacheTtl;
      const ttlDisplay = cacheTtl !== undefined ? String(cacheTtl) : 'forever';
      console.log(`    ${ansis.gray('TTL:')} ${ttlDisplay}`);
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
