import { define } from 'gunshi';
import { loadEnvGraph } from '../../../env-graph';
import { isBundledSEA } from '../helpers/install-detection';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { EnvSchemaStore } from '../../env-schema-store';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

export const commandSpec = define({
  name: 'doctor',
  description: 'Debug and diagnose issues with your env file(s) and system',
  args: {
    'schema-store': {
      type: 'boolean',
      description: 'Enable experimental schema store validation (set VARLOCK_SCHEMA_STORE=true to enable by default)',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Show detailed output',
      default: false,
    },
  },
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  console.log('');
  console.log('🧙 Scanning for issues... ✨');
  console.log('');

  // System checks
  console.log(chalk.bold('System Information:'));
  console.log(`  Bundled SEA: ${isBundledSEA() ? '✅ Yes' : '❌ No'}`);
  console.log('');

  // Load and validate env
  const envGraph = await loadEnvGraph();
  await envGraph.resolveEnvValues();
  const resolvedEnv = envGraph.getResolvedEnvObject();

  // Schema Store validation (experimental feature)
  const schemaStoreEnabled = ctx.args['schema-store'] || process.env.VARLOCK_SCHEMA_STORE === 'true';
  if (schemaStoreEnabled) {
    console.log(chalk.bold('Environment Schema Validation (Experimental):'));
    
    try {
      const store = new EnvSchemaStore({
        autoDiscovery: true,
        telemetry: false, // Don't send telemetry during doctor command
      });

      await store.initialize();

      const schemas = store.getSchemas();
      if (schemas.length > 0) {
        console.log(`  Found ${chalk.green(schemas.length)} schema(s):`);
        for (const schema of schemas) {
          const source = schema.source === 'auto' ? '(auto-discovered)' : 
                         schema.source === 'explicit' ? '(explicitly loaded)' : 
                         '(vendor-provided)';
          console.log(`    - ${chalk.cyan(schema.name)} ${schema.version || ''} ${chalk.gray(source)}`);
        }
        console.log('');

        // Validate environment variables
        const validation = await store.validate(resolvedEnv);

        if (validation.valid) {
          console.log(chalk.green('  ✅ All required environment variables are set correctly!'));
        } else {
          console.log(chalk.red('  ❌ Environment validation failed:'));
          console.log('');

          // Show errors
          if (validation.errors.length > 0) {
            console.log(chalk.yellow('  Validation Errors:'));
            for (const error of validation.errors) {
              const icon = error.severity === 'error' ? '❌' : 
                          error.severity === 'warning' ? '⚠️' : 'ℹ️';
              console.log(`    ${icon} ${chalk.bold(error.variable)}: ${error.message}`);
            }
            console.log('');
          }

          // Show missing variables
          const requiredMissing = validation.missing.filter(m => m.required);
          const suggestedMissing = validation.missing.filter(m => m.suggested && !m.required);

          if (requiredMissing.length > 0) {
            console.log(chalk.red('  Missing Required Variables:'));
            for (const missing of requiredMissing) {
              console.log(`    ❌ ${chalk.bold(missing.variable)}${missing.description ? `: ${missing.description}` : ''}`);
            }
            console.log('');
          }

          if (suggestedMissing.length > 0 && ctx.args.verbose) {
            console.log(chalk.yellow('  Missing Suggested Variables:'));
            for (const missing of suggestedMissing) {
              console.log(`    ⚠️ ${chalk.bold(missing.variable)}${missing.description ? `: ${missing.description}` : ''}`);
            }
            console.log('');
          }
        }

        // Show how to fix issues
        if (!validation.valid) {
          console.log(chalk.bold('  💡 How to fix:'));
          console.log('    1. Add the missing variables to your .env file');
          console.log('    2. Run ' + chalk.cyan('varlock doctor') + ' again to verify');
          console.log('    3. Use ' + chalk.cyan('varlock run <command>') + ' to run with validated environment');
          console.log('');
        }
      } else {
        console.log(chalk.gray('  No schemas found. Install supported packages or add @load directives.'));
        console.log('');
      }
    } catch (error) {
      console.log(chalk.red('  Failed to validate with schema store:'), error);
      console.log('');
    }
  }

  // Check for .env file issues
  console.log(chalk.bold('Environment Files:'));
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    console.log(`  .env file found with ${lines.length} lines`);
    
    // Count variables
    const varCount = lines.filter(l => l.match(/^[A-Z_][A-Z0-9_]*=/)).length;
    const decoratorCount = lines.filter(l => l.includes('@')).length;
    console.log(`    - ${varCount} variable(s) defined`);
    console.log(`    - ${decoratorCount} line(s) with decorators`);
  } else {
    console.log(chalk.yellow('  ⚠️ No .env file found'));
  }
  console.log('');

  // TODO: Mac app checks
  // - installed, running, logged in, set up (keys exist), locked/unlocked state

  console.log(chalk.green('✨ Doctor check complete!'));
};

