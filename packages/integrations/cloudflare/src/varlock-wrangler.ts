/* eslint-disable no-console */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import { execSyncVarlock } from 'varlock/exec-sync-varlock';

function spawnWrangler(args: Array<string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('wrangler', args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
      if ((err as any).code === 'ENOENT') {
        console.error('Error: wrangler not found. Install it with your package manager:');
        console.error('  npm install wrangler');
      }
      reject(err);
    });
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

function loadSerializedGraph() {
  const serializedGraphJson = execSyncVarlock('load --format json-full --compact', {
    showLogsOnError: true,
  });
  return {
    json: serializedGraphJson,
    graph: JSON.parse(serializedGraphJson) as {
      config: Record<string, { value: unknown, isSensitive: boolean }>,
    },
  };
}

function isDeployCommand(args: Array<string>) {
  if (args[0] === 'deploy') return true;
  if (args[0] === 'versions' && args[1] === 'upload') return true;
  return false;
}

function isTypesCommand(args: Array<string>) {
  return args[0] === 'types';
}

async function handleDeploy(args: Array<string>) {
  // check if user already passed --secrets-file
  if (args.includes('--secrets-file')) {
    console.error('Error: --secrets-file is managed automatically by varlock-wrangler.');
    console.error('Remove --secrets-file from your command and let varlock handle it.');
    process.exitCode = 1;
    return;
  }

  let loaded;
  try {
    loaded = loadSerializedGraph();
  } catch {
    console.error('Failed to resolve environment variables');
    process.exitCode = 1;
    return;
  }

  // split resolved vars into:
  // - non-sensitive → --var flags (visible in CF dashboard as environment variables)
  // - sensitive → --secrets-file (stored as CF secrets)
  // - __VARLOCK_ENV blob → always a secret (contains full graph including sensitive values)
  const varFlags: Array<string> = [];
  const secretsObj: Record<string, string> = {};

  for (const key in loaded.graph.config) {
    const item = loaded.graph.config[key];
    if (item.value === undefined) continue;
    const strValue = typeof item.value === 'string' ? item.value : JSON.stringify(item.value);

    if (item.isSensitive) {
      secretsObj[key] = strValue;
    } else {
      // wrangler splits KEY:VALUE on the first `:` only, so colons in values are safe
      // spawn args array passes newlines/special chars without shell escaping issues
      varFlags.push('--var', `${key}:${strValue}`);
    }
  }
  // always a secret since it contains sensitive values
  secretsObj.__VARLOCK_ENV = loaded.json;

  // write secrets to temp file (NOT in the project directory)
  const tmpFile = join(tmpdir(), `varlock-secrets-${randomBytes(8).toString('hex')}.json`);

  function cleanup() {
    try {
      unlinkSync(tmpFile);
    } catch {
      // file may already be deleted
    }
  }

  process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(1);
  });

  try {
    writeFileSync(tmpFile, JSON.stringify(secretsObj));

    const exitCode = await spawnWrangler([...args, ...varFlags, '--secrets-file', tmpFile]);
    process.exitCode = exitCode;
  } finally {
    cleanup();
  }
}

async function handleTypes(args: Array<string>) {
  let loaded;
  try {
    loaded = loadSerializedGraph();
  } catch {
    console.error('Failed to resolve environment variables');
    process.exitCode = 1;
    return;
  }

  // generate a temp env file with just key names (no real values)
  // wrangler types reads this to discover which vars to include in the Env interface
  const envFileLines: Array<string> = [];
  for (const key in loaded.graph.config) {
    envFileLines.push(`${key}=`);
  }

  const tmpFile = join(tmpdir(), `varlock-types-env-${randomBytes(8).toString('hex')}`);

  function cleanup() {
    try {
      unlinkSync(tmpFile);
    } catch {
      // file may already be deleted
    }
  }

  try {
    writeFileSync(tmpFile, envFileLines.join('\n'));

    const exitCode = await spawnWrangler([...args, '--env-file', tmpFile]);
    process.exitCode = exitCode;
  } finally {
    cleanup();
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('varlock-wrangler: a drop-in replacement for `wrangler` that injects resolved env');
    console.log('Usage: varlock-wrangler <wrangler-command> [options]');
    console.log('');
    console.log('Enhanced commands:');
    console.log('  deploy / versions upload - uploads env as Cloudflare vars and secrets');
    console.log('  types                    - generates types including varlock-managed env vars');
    console.log('');
    console.log('All other commands are passed through to wrangler unchanged.');
    return;
  }

  if (isDeployCommand(args)) {
    await handleDeploy(args);
  } else if (isTypesCommand(args)) {
    await handleTypes(args);
  } else {
    // pass through to wrangler unchanged
    const exitCode = await spawnWrangler(args);
    process.exitCode = exitCode;
  }
}

main();
