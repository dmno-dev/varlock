/**
 * Core sync logic for pushing varlock-resolved environment variables to a Convex deployment.
 *
 * Uses the Convex CLI (`npx convex env set`) as the transport mechanism.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SerializedEnvGraph } from 'varlock';
import { execSyncVarlock } from 'varlock/exec-sync-varlock';

export type { SerializedEnvGraph };

export type SerializedConfig = SerializedEnvGraph['config'];

export type SyncOptions = {
  /** Convex deploy key. Falls back to CONVEX_DEPLOY_KEY env var. */
  deployKey?: string;

  /** Path to .env.schema or project directory. Passed to varlock load --path. */
  schemaPath?: string;

  /** Environment name (e.g., 'production'). Passed to varlock load --env. */
  env?: string;

  /** Push the __VARLOCK_ENV blob for `import { ENV } from 'varlock/env'` support. Default: true. */
  pushBlob?: boolean;

  /** Push individual env vars for `process.env.KEY` access. Default: true. */
  pushIndividual?: boolean;

  /** Preview changes without pushing. */
  dryRun?: boolean;

  /** Use --prod flag when calling Convex CLI. */
  prod?: boolean;
};

export type SyncResult = {
  /** Variables that were synced (or would be synced in dry-run mode). */
  variables: Array<{ name: string; sensitive: boolean }>;
  /** Whether the __VARLOCK_ENV blob was included. */
  blobPushed: boolean;
  /** Total bytes of the __VARLOCK_ENV blob (if pushed). */
  blobSize?: number;
  /** Whether this was a dry run. */
  dryRun: boolean;
};

/**
 * Resolve env vars via varlock and filter to items tagged with @syncTarget(convex).
 */
export function resolveAndFilter(options: Pick<SyncOptions, 'schemaPath' | 'env'>): {
  graph: SerializedEnvGraph;
  convexItems: Array<{ key: string; value: any; isSensitive: boolean }>;
} {
  const args = ['load', '--format', 'json-full', '--compact'];
  if (options.schemaPath) args.push('--path', options.schemaPath);
  if (options.env) args.push('--env', options.env);

  const result = execSyncVarlock(args.join(' '), {
    showLogsOnError: true,
  });

  const graph: SerializedEnvGraph = JSON.parse(result);

  // filter to items with @syncTarget(convex)
  const convexItems: Array<{ key: string; value: any; isSensitive: boolean }> = [];
  for (const [key, item] of Object.entries(graph.config)) {
    if (item.syncTargets?.includes('convex')) {
      convexItems.push({ key, value: item.value, isSensitive: item.isSensitive });
    }
  }

  return { graph, convexItems };
}

/**
 * Build a minimal __VARLOCK_ENV blob containing only the Convex-targeted items.
 * Strips basePath and sources (not needed at runtime).
 */
export function buildConvexBlob(
  graph: SerializedEnvGraph,
  convexItems: Array<{ key: string; value: any; isSensitive: boolean }>,
): string {
  const minimalGraph: Omit<SerializedEnvGraph, 'basePath' | 'sources'> = {
    settings: graph.settings,
    config: {},
  };
  for (const item of convexItems) {
    minimalGraph.config[item.key] = {
      value: item.value,
      isSensitive: item.isSensitive,
    };
  }
  return JSON.stringify(minimalGraph);
}

/**
 * Push resolved env vars to a Convex deployment using the Convex CLI.
 */
export async function syncToConvex(options: SyncOptions = {}): Promise<SyncResult> {
  const pushBlob = options.pushBlob ?? true;
  const pushIndividual = options.pushIndividual ?? true;
  const dryRun = options.dryRun ?? false;
  const deployKey = options.deployKey ?? process.env.CONVEX_DEPLOY_KEY;

  // resolve and filter
  const { graph, convexItems } = resolveAndFilter({
    schemaPath: options.schemaPath,
    env: options.env,
  });

  if (convexItems.length === 0) {
    console.warn('No variables with @syncTarget(convex) found. Nothing to sync.');
    return { variables: [], blobPushed: false, dryRun };
  }

  const result: SyncResult = {
    variables: convexItems.map((i) => ({ name: i.key, sensitive: i.isSensitive })),
    blobPushed: pushBlob,
    dryRun,
  };

  if (dryRun) {
    console.log('Dry run - would sync the following variables to Convex:');
    for (const item of convexItems) {
      const label = item.isSensitive ? ' [sensitive]' : '';
      console.log(`  ${item.key}${label}`);
    }
    if (pushBlob) {
      const blob = buildConvexBlob(graph, convexItems);
      result.blobSize = Buffer.byteLength(blob, 'utf-8');
      console.log(`  __VARLOCK_ENV (blob, ${result.blobSize} bytes)`);
      if (result.blobSize > 8192) {
        console.warn(`  WARNING: blob exceeds Convex's 8KB env var limit (${result.blobSize} bytes)`);
        console.warn('  Consider using --no-blob and relying on individual vars only');
      }
    }
    return result;
  }

  // build convex CLI env with deploy key
  const convexEnv = { ...process.env };
  if (deployKey) {
    convexEnv.CONVEX_DEPLOY_KEY = deployKey;
  }

  const convexFlags = options.prod ? ' --prod' : '';

  // push individual vars via a temp .env file
  if (pushIndividual) {
    const envFileLines: Array<string> = [];
    for (const item of convexItems) {
      const value = item.value === undefined ? '' : String(item.value);
      // escape double quotes and newlines for .env format
      const escaped = value.replace(/"/g, '\\"').replace(/\n/g, '\\n');
      envFileLines.push(`${item.key}="${escaped}"`);
    }

    const tmpFile = path.join(os.tmpdir(), `varlock-convex-sync-${Date.now()}.env`);
    try {
      fs.writeFileSync(tmpFile, envFileLines.join('\n'), { encoding: 'utf-8', mode: 0o600 });
      execSync(`npx convex env set --from-file "${tmpFile}" --force${convexFlags}`, {
        env: convexEnv,
        stdio: 'inherit',
      });
    } finally {
      // clean up temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch { /* ignore */ }
    }
  }

  // push __VARLOCK_ENV blob
  if (pushBlob) {
    const blob = buildConvexBlob(graph, convexItems);
    result.blobSize = Buffer.byteLength(blob, 'utf-8');

    if (result.blobSize > 8192) {
      console.warn(`WARNING: __VARLOCK_ENV blob is ${result.blobSize} bytes, exceeding Convex's 8KB limit.`);
      console.warn('Skipping blob push. Use --no-blob or reduce the number of synced variables.');
      result.blobPushed = false;
    } else {
      // write blob to temp file and use --from-file to avoid shell escaping issues
      const tmpFile = path.join(os.tmpdir(), `varlock-convex-blob-${Date.now()}.env`);
      try {
        fs.writeFileSync(tmpFile, `__VARLOCK_ENV=${blob}`, { encoding: 'utf-8', mode: 0o600 });
        execSync(`npx convex env set --from-file "${tmpFile}" --force${convexFlags}`, {
          env: convexEnv,
          stdio: 'inherit',
        });
      } finally {
        try {
          fs.unlinkSync(tmpFile);
        } catch { /* ignore */ }
      }
    }
  }

  console.log(`Synced ${convexItems.length} variables to Convex${pushBlob && result.blobPushed ? ' (+ __VARLOCK_ENV blob)' : ''}`);
  return result;
}
