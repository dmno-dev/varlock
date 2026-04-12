import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';

export const commandSpec = define({
  name: 'printenv',
  description: 'Print the resolved value of a single environment variable',
  args: {
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory (with trailing slash) to use as the entry point (can be specified multiple times)',
    },
  },
  examples: `
Prints the resolved value of a single environment variable.
Useful within larger shell commands where you need a single env var value.

Examples:
  varlock printenv MY_VAR                    # Print the value of MY_VAR
  varlock printenv --path .env.prod MY_VAR   # Use a specific .env file
  varlock printenv --path ./config/ MY_VAR   # Use a specific directory
  varlock printenv -p ./envs -p ./overrides MY_VAR  # Use multiple directories

📍 Note: Use sh -c to embed this in shell commands, e.g.:
       sh -c 'do-something --token $(varlock printenv MY_TOKEN)'

💡 Tip: Unlike \`varlock run -- echo $MY_VAR\`, this works because the shell
       expansion happens after varlock has printed the value.
  `.trim(),
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  // ctx.positionals includes the subcommand name(s) themselves, so we skip them
  // by slicing off ctx.commandPath.length entries (e.g. skips 'printenv' at index 0)
  const positionals = (ctx.positionals ?? []).slice(ctx.commandPath?.length ?? 0);
  if (!positionals.length) {
    throw new CliExitError('Missing required argument: variable name', {
      suggestion: 'Run `varlock printenv MY_VAR` to print the value of MY_VAR',
    });
  }
  const varName = positionals[0];

  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths: ctx.values.path,
  });
  checkForSchemaErrors(envGraph);

  if (!(varName in envGraph.configSchema)) {
    throw new CliExitError(`Variable "${varName}" not found in schema`);
  }

  // Resolve only the requested item and its transitive dependencies
  await envGraph.resolveItemWithDeps(varName);

  const item = envGraph.configSchema[varName];
  if (item.validationState === 'error') {
    for (const err of item.errors) {
      console.error(`🚨 ${err.message}`);
    }
    return gracefulExit(1);
  }

  const value = item.resolvedValue;
  if (value === undefined || value === null) {
    console.log('');
  } else {
    console.log(String(value));
  }
};
