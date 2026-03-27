/* eslint-disable no-console */

import {
  writeFileSync, unlinkSync, watch, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, execSync } from 'node:child_process';

import { execSyncVarlock } from 'varlock/exec-sync-varlock';

const isWindows = process.platform === 'win32';
const debugEnabled = !!process.env.VARLOCK_DEBUG;
function debug(...args: Array<any>) {
  if (debugEnabled) console.log('[varlock-wrangler]', ...args);
}

/** Detect the package manager exec command from npm_config_user_agent */
function getExecPrefix(): string {
  const ua = process.env.npm_config_user_agent || '';
  if (ua.startsWith('pnpm/')) return 'pnpm exec ';
  if (ua.startsWith('yarn/')) return 'yarn exec ';
  if (ua.startsWith('bun/')) return 'bunx ';
  if (ua.startsWith('npm/')) return 'npx ';
  return '';
}

// --- shared helpers ---

function spawnWrangler(args: Array<string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('wrangler', args, {
      stdio: 'inherit',
      shell: isWindows,
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

function tmpPath(prefix: string) {
  return join(tmpdir(), `${prefix}-${randomBytes(8).toString('hex')}`);
}

/**
 * Creates a named pipe (FIFO) for long-running commands (dev).
 * On Unix: data only exists in a kernel buffer — secrets never touch disk.
 * On Windows: falls back to a regular temp file.
 */
function createServingTempFile(prefix: string) {
  const filePath = tmpPath(prefix);

  if (!isWindows) {
    execSync(`mkfifo "${filePath}"`);
  }

  function cleanup() {
    try {
      unlinkSync(filePath);
    } catch {
      // may already be deleted
    }
  }

  /**
   * Start serving content via the FIFO (or write a regular file on Windows).
   * On Unix: spawns a child process that writes to the FIFO in a loop.
   * Using a child process means the blocked libuv thread lives in the child —
   * killing the child cleanly releases it, allowing our main process to exit.
   * On Windows: writes a regular file, with refresh() to update it.
   */
  function startServing(getContent: () => string) {
    if (isWindows) {
      writeFileSync(filePath, getContent());
      return {
        refresh() { writeFileSync(filePath, getContent()); },
        update(content: string) { writeFileSync(filePath, content); },
        stop() {
          /* noop on Windows */
        },
      };
    }

    // spawn a child process to serve the FIFO
    // the child reads content from stdin, then writes it to the FIFO in a loop
    const fifoServer = spawn(process.execPath, [
      '-e', `
      const fs = require('fs');
      const path = ${JSON.stringify(filePath)};
      let content = '';
      process.stdin.on('data', d => content += d);
      process.stdin.on('end', () => {
        (function serve() {
          try { fs.writeFileSync(path, content); setImmediate(serve); }
          catch { process.exit(); }
        })();
      });
    `,
    ], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    fifoServer.stdin!.write(getContent());
    fifoServer.stdin!.end();

    return {
      /** Update content — not needed on Unix (FIFO reads getContent() each time via dev watcher) */
      refresh() {
        /* noop — FIFO serves fresh content from getContent() */
      },
      /** Kill and respawn the FIFO server with new content */
      update(content: string) {
        fifoServer.kill();
        const replacement = startServing(() => content);
        // swap the stop/update methods on this handle
        this.stop = replacement.stop;
        this.update = replacement.update;
      },
      stop() {
        fifoServer.kill();
      },
    };
  }

  return {
    filePath, cleanup, startServing,
  };
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

function formatEnvFileContent(graph: ReturnType<typeof loadSerializedGraph>) {
  // output as dotenv format using single quotes — single-quoted values are
  // treated as literal strings with no escape processing, which avoids issues
  // with double quotes in JSON blobs and special characters in values.
  // values containing single quotes are double-quoted with escaping instead.
  const lines: Array<string> = [
    '# ⚠️  AUTO-GENERATED BY VARLOCK — DO NOT EDIT',
    `# ${isWindows ? 'This is a temporary file and will be cleaned up automatically.' : 'This file is served via a named pipe (FIFO) and exists only in memory.'}`,
    '# Your .env files and .env.schema are the source of truth.',
    '# See https://varlock.dev/integrations/cloudflare/ for details.',
    '',
  ];
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

// --- command detection ---

function isDeployCommand(args: Array<string>) {
  if (args[0] === 'deploy') return true;
  if (args[0] === 'versions' && args[1] === 'upload') return true;
  return false;
}

function isTypesCommand(args: Array<string>) {
  return args[0] === 'types';
}

// --- command handlers ---

async function handleDeploy(args: Array<string>) {
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
  secretsObj.__VARLOCK_ENV = loaded.json;

  const tmp = createServingTempFile('varlock-secrets');
  const content = JSON.stringify(secretsObj);
  debug('deploy: starting FIFO serve');
  const handle = tmp.startServing(() => content);

  process.on('SIGINT', () => {
    handle.stop();
    tmp.cleanup();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    handle.stop();
    tmp.cleanup();
    process.exit(1);
  });

  let exitCode = 0;
  try {
    debug('deploy: spawning wrangler');
    exitCode = await spawnWrangler([...args, ...varFlags, '--secrets-file', tmp.filePath, '--keep-vars=false']);
    debug('deploy: wrangler exited with code', exitCode);
  } finally {
    debug('deploy: cleaning up');
    handle.stop();
    tmp.cleanup();
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

  const tmp = createServingTempFile('varlock-types-env');
  debug('types: starting FIFO serve');
  const handle = tmp.startServing(() => envFileLines.join('\n'));

  let exitCode = 0;
  try {
    debug('types: spawning wrangler');
    exitCode = await spawnWrangler([...args, '--env-file', tmp.filePath]);
    debug('types: wrangler exited with code', exitCode);
  } finally {
    debug('types: cleaning up');
    handle.stop();
    tmp.cleanup();
  }
}

async function handleDev(args: Array<string>) {
  // .dev.vars would conflict with our env injection via --env-file
  if (existsSync('.dev.vars')) {
    console.error([
      'Error: a .dev.vars file was detected in your project.',
      'This conflicts with varlock-wrangler which manages env vars automatically.',
      'Remove .dev.vars and define your variables in .env files with a .env.schema instead.',
    ].join('\n'));
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

  const tmp = createServingTempFile('varlock-dev-env');

  let cachedContent = formatEnvFileContent(loaded);
  let wranglerChild: ReturnType<typeof spawn> | undefined;
  const watchers: Array<ReturnType<typeof watch>> = [];

  const handle = tmp.startServing(() => cachedContent);

  function cleanup() {
    handle.stop();
    for (const w of watchers) w.close();
    tmp.cleanup();
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
        handle.update(cachedContent);
        console.log('[varlock-wrangler] env changed, restarting wrangler...');
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

  try {
    // outer loop: (re)spawn wrangler each time it exits
    // on env file changes, the watcher kills wrangler, which causes it to respawn
    // with the fresh data (FIFO serves fresh content, Windows file is refreshed)
    while (handle) {
      wranglerChild = spawn('wrangler', [...args, '--env-file', tmp.filePath], {
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: isWindows,
        // force color output since piped stdio loses TTY detection
        env: { ...process.env, FORCE_COLOR: '1' },
      });

      // pipe wrangler output with rewrites:
      // - replace FIFO path reference with a friendlier message
      // - strip env var binding rows (other bindings like KV, D1 are preserved)
      const tmpBasename = tmp.filePath.split(/[/\\]/).pop()!;
      const loadCmd = `${getExecPrefix()}varlock load`;
      let shownVarlockNotice = false;
      const varlockNotice = '\x1b[36m✨ env vars managed by varlock 🧙🔒\x1b[0m\n'
        + `\x1b[2m   run \`${loadCmd}\` to inspect\x1b[0m\n`;
      const rewriteOutput = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
        let str = chunk.toString();
        // strip the FIFO path line entirely
        if (str.includes(tmpBasename)) {
          str = str.replace(/.*varlock-dev-env-[a-f0-9]+.*\n?/g, '');
        }
        // replace env var binding rows with a single varlock notice
        // (other bindings like KV, D1 are preserved)
        if (str.includes('Environment Variable')) {
          if (!shownVarlockNotice) {
            str = str.replace(/.*Environment Variable.*\n?/, varlockNotice);
            shownVarlockNotice = true;
          }
          str = str.replace(/.*Environment Variable.*\n?/g, '');
        }
        // rewrite wrangler types hint to use varlock-wrangler
        if (str.includes('wrangler types')) {
          str = str.replace(/wrangler types/g, 'varlock-wrangler types');
        }
        if (str) stream.write(str);
      };
      wranglerChild.stdout?.on('data', rewriteOutput(process.stdout));
      wranglerChild.stderr?.on('data', rewriteOutput(process.stderr));

      const child = wranglerChild;
      const exitCode = await new Promise<number>((resolve) => {
        child.on('error', (err) => {
          if ((err as any).code === 'ENOENT') {
            console.error('Error: wrangler not found. Install it with your package manager:');
            console.error('  npm install wrangler');
          }
          resolve(1);
        });
        child.on('exit', (code, signal) => {
          resolve(code ?? (signal ? 1 : 0));
        });
      });

      // if wrangler exited on its own (not killed by us for restart), stop
      if (!restartTimeout) {
        process.exitCode = exitCode;
        break;
      }
    }
  } finally {
    cleanup();
  }
}

// --- main ---

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
