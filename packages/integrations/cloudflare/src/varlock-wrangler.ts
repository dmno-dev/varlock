/* eslint-disable no-console */

import { writeFileSync, unlinkSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, execSync } from 'node:child_process';

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
      basePath?: string,
      sources: Array<{ label: string, enabled: boolean, path?: string }>,
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

function formatEnvFileContent(graph: ReturnType<typeof loadSerializedGraph>) {
  // output as dotenv format using single quotes — single-quoted values are
  // treated as literal strings with no escape processing, which avoids issues
  // with double quotes in JSON blobs and special characters in values.
  // values containing single quotes are double-quoted with escaping instead.
  const lines: Array<string> = [];
  for (const key in graph.graph.config) {
    const item = graph.graph.config[key];
    if (item.value === undefined) continue;
    const strValue = typeof item.value === 'string' ? item.value : JSON.stringify(item.value);
    lines.push(formatEnvLine(key, strValue));
  }
  // include __VARLOCK_ENV for the varlock runtime (compact JSON, no newlines)
  lines.push(formatEnvLine('__VARLOCK_ENV', graph.json));
  return lines.join('\n');
}

function formatEnvLine(key: string, value: string): string {
  if (!value.includes("'")) {
    // single quotes — literal, no escaping needed
    return `${key}='${value}'`;
  }
  // fall back to double quotes with escaping
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `${key}="${escaped}"`;
}

async function handleDev(args: Array<string>) {
  let loaded;
  try {
    loaded = loadSerializedGraph();
  } catch {
    console.error('Failed to resolve environment variables');
    process.exitCode = 1;
    return;
  }

  // create a named pipe (FIFO) so secrets never touch disk as plaintext files
  // the FIFO is a special filesystem node — data only exists in a kernel buffer
  // and is consumed on read, leaving nothing at rest
  const fifoPath = join(tmpdir(), `varlock-dev-env-${randomBytes(8).toString('hex')}`);
  execSync(`mkfifo "${fifoPath}"`);

  let serving = true;
  let cachedContent = formatEnvFileContent(loaded);
  let wranglerChild: ReturnType<typeof spawn> | undefined;
  const watchers: Array<ReturnType<typeof watch>> = [];

  function cleanup() {
    serving = false;
    for (const w of watchers) w.close();
    try {
      unlinkSync(fifoPath);
    } catch {
      // FIFO may already be deleted
    }
  }

  process.on('SIGINT', () => {
    wranglerChild?.kill();
    cleanup();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    wranglerChild?.kill();
    cleanup();
    process.exit(1);
  });

  // watch env source files for changes and restart wrangler with fresh data
  let restartTimeout: ReturnType<typeof setTimeout> | undefined;
  function scheduleRestart() {
    // debounce — multiple files may change at once
    if (restartTimeout) clearTimeout(restartTimeout);
    restartTimeout = setTimeout(() => {
      try {
        const freshLoaded = loadSerializedGraph();
        cachedContent = formatEnvFileContent(freshLoaded);
        console.log('[varlock-wrangler] env changed, restarting wrangler...');
        // kill wrangler — it will be respawned by the outer loop
        wranglerChild?.kill();
      } catch (err) {
        console.error('[varlock-wrangler] failed to re-resolve env:', (err as Error).message);
      }
    }, 300);
  }

  // set up watchers on env source files
  if (loaded.graph.basePath) {
    for (const source of loaded.graph.sources) {
      if (!source.enabled || !source.path) continue;
      const fullPath = join(loaded.graph.basePath, source.path);
      try {
        const w = watch(fullPath, () => scheduleRestart());
        watchers.push(w);
      } catch {
        // file may not exist yet (e.g., optional env-specific file)
      }
    }
  }

  // serve the FIFO in a loop — each writeFile call blocks (in libuv thread pool)
  // until a reader opens the FIFO, then data flows and the write completes.
  // wrangler reads the env file multiple times (validate then parse), so we
  // keep serving the same cached data until it's updated by the file watcher.

  (async () => {
    while (serving) {
      try {
        await writeFile(fifoPath, cachedContent);
      } catch {
        // FIFO deleted or error — stop serving
        break;
      }
    }
  })();

  try {
    // outer loop: (re)spawn wrangler each time it exits
    // on env file changes, the watcher kills wrangler, which causes it to respawn
    // with the fresh FIFO data
    while (serving) {
      wranglerChild = spawn('wrangler', [...args, '--env-file', fifoPath], {
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        // force color output since piped stdio loses TTY detection
        env: { ...process.env, FORCE_COLOR: '1' },
      });

      // pipe wrangler output, replacing the FIFO path reference with a friendlier message
      const fifoBasename = fifoPath.split('/').pop()!;
      const rewriteOutput = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
        let str = chunk.toString();
        if (str.includes(fifoBasename)) {
          str = str.replace(/.*varlock-dev-env-[a-f0-9]+.*\n?/g, '✨ Using config/secrets injected via varlock 🧙🔒\n');
        }
        stream.write(str);
      };
      wranglerChild.stdout?.on('data', rewriteOutput(process.stdout));
      wranglerChild.stderr?.on('data', rewriteOutput(process.stderr));

      const exitCode = await new Promise<number>((resolve) => {
        wranglerChild!.on('error', (err) => {
          if ((err as any).code === 'ENOENT') {
            console.error('Error: wrangler not found. Install it with your package manager:');
            console.error('  npm install wrangler');
          }
          resolve(1);
        });
        wranglerChild!.on('exit', (code, signal) => {
          resolve(code ?? (signal ? 1 : 0));
        });
      });

      // if wrangler exited on its own (not killed by us for restart), stop
      if (serving && !restartTimeout) {
        process.exitCode = exitCode;
        serving = false;
      }
    }
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
    console.log('  dev                      - injects resolved env via named pipe (no secrets on disk)');
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
  } else if (args[0] === 'dev') {
    await handleDev(args);
  } else {
    // pass through to wrangler unchanged
    const exitCode = await spawnWrangler(args);
    process.exitCode = exitCode;
  }
}

main();
