#!/usr/bin/env node

/**
 * CLI for syncing varlock-resolved environment variables to a Convex deployment.
 *
 * Usage:
 *   varlock-convex-sync [options]
 *
 * Options:
 *   --deploy-key <key>   Convex deploy key (or set CONVEX_DEPLOY_KEY env var)
 *   --env <name>         Environment name (e.g., production, staging)
 *   --path <path>        Path to .env.schema or project directory
 *   --prod               Use --prod flag for Convex CLI
 *   --no-blob            Skip pushing the __VARLOCK_ENV blob
 *   --no-individual      Skip pushing individual env vars
 *   --dry-run            Preview changes without pushing
 *   --help               Show this help message
 */

import { syncToConvex } from './index.js';

function printHelp() {
  console.log(`
varlock-convex-sync - Sync varlock-resolved env vars to a Convex deployment

Usage:
  varlock-convex-sync [options]

Options:
  --deploy-key <key>   Convex deploy key (or set CONVEX_DEPLOY_KEY env var)
  --env <name>         Environment name (e.g., production, staging)
  --path <path>        Path to .env.schema or project directory
  --prod               Use --prod flag for Convex CLI
  --no-blob            Skip pushing the __VARLOCK_ENV blob
  --no-individual      Skip pushing individual env vars
  --dry-run            Preview changes without pushing
  --help               Show this help message

Environment Variables:
  CONVEX_DEPLOY_KEY    Convex deploy key (alternative to --deploy-key)

Examples:
  # Sync to dev deployment
  varlock-convex-sync --deploy-key $CONVEX_DEPLOY_KEY

  # Sync to production
  varlock-convex-sync --deploy-key $CONVEX_DEPLOY_KEY --env production --prod

  # Preview what would be synced
  varlock-convex-sync --dry-run

  # In CI/deploy pipeline
  npx convex deploy --cmd "varlock-convex-sync"
`.trim());
}

function parseArgs(argv: Array<string>) {
  const args: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--prod') {
      args.prod = true;
    } else if (arg === '--no-blob') {
      args.noBlob = true;
    } else if (arg === '--no-individual') {
      args.noIndividual = true;
    } else if (arg === '--deploy-key' && i + 1 < argv.length) {
      args.deployKey = argv[++i];
    } else if (arg === '--env' && i + 1 < argv.length) {
      args.env = argv[++i];
    } else if (arg === '--path' && i + 1 < argv.length) {
      args.path = argv[++i];
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
    i++;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    const result = await syncToConvex({
      deployKey: typeof args.deployKey === 'string' ? args.deployKey : undefined,
      schemaPath: typeof args.path === 'string' ? args.path : undefined,
      env: typeof args.env === 'string' ? args.env : undefined,
      prod: !!args.prod,
      pushBlob: !args.noBlob,
      pushIndividual: !args.noIndividual,
      dryRun: !!args.dryRun,
    });

    if (result.dryRun) {
      process.exit(0);
    }

    if (result.variables.length === 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Failed to sync to Convex:', (err as Error).message);
    process.exit(1);
  }
}

main();
