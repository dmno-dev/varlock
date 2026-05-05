import path from 'node:path';
import {
  existsSync, readdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { varlockVitePlugin, varlockLoadedEnv } from '@varlock/vite-integration';
import { execSyncVarlock } from 'varlock/exec-sync-varlock';
import { cloudflare, type PluginConfig, type WorkerConfig } from '@cloudflare/vite-plugin';
import { CLOUDFLARE_SSR_ENTRY_CODE } from './shared-ssr-entry-code';

const isWindows = process.platform === 'win32';

/** Name exposed by `@cloudflare/vite-plugin`'s main plugin object. */
const CLOUDFLARE_PLUGIN_NAME = 'vite-plugin-cloudflare';


// --- helpers for preview FIFO env injection --------------------------------

const CF_SECRET_MAX_BYTES = 5120;

/**
 * Finds the `.dev.vars` path next to the built `wrangler.json` in the build output.
 * The CF plugin names output directories after the worker (e.g. `dist/test_worker/`),
 * so we scan `dist/` subdirectories for the one containing `wrangler.json`.
 */
function findDevVarsPath(root: string): string | undefined {
  const distDir = path.resolve(root, 'dist');
  if (!existsSync(distDir)) return undefined;

  // Check immediate subdirectories of dist/ for wrangler.json
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const wranglerPath = path.join(distDir, entry.name, 'wrangler.json');
    if (existsSync(wranglerPath)) {
      return path.join(distDir, entry.name, '.dev.vars');
    }
  }
  return undefined;
}

function cleanupFile(filePath: string) {
  try {
    unlinkSync(filePath);
  } catch {
    // may already be deleted
  }
}

function chunkString(str: string, maxBytes: number): Array<string> {
  const chunks: Array<string> = [];
  let current = '';
  let currentBytes = 0;
  for (const char of str) {
    const charBytes = Buffer.byteLength(char);
    if (currentBytes + charBytes > maxBytes && current) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

function formatEnvLine(key: string, value: string): string {
  if (!value.includes("'")) {
    return `${key}='${value}'`;
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `${key}="${escaped}"`;
}

function formatDevVarsContent(
  graph: { config: Record<string, { value: unknown }> },
  serializedGraph: string,
) {
  const lines: Array<string> = [];
  for (const key in graph.config) {
    const item = graph.config[key];
    if (item.value === undefined) continue;
    const strValue = typeof item.value === 'string' ? item.value : JSON.stringify(item.value);
    lines.push(formatEnvLine(key, strValue));
  }
  // include __VARLOCK_ENV (compact JSON) for the varlock runtime,
  // split into chunks if it exceeds CF's 5KB secret limit
  if (Buffer.byteLength(serializedGraph) <= CF_SECRET_MAX_BYTES) {
    lines.push(formatEnvLine('__VARLOCK_ENV', serializedGraph));
  } else {
    const chunks = chunkString(serializedGraph, CF_SECRET_MAX_BYTES);
    lines.push(formatEnvLine('__VARLOCK_ENV_CHUNKS', String(chunks.length)));
    for (let i = 0; i < chunks.length; i++) {
      lines.push(formatEnvLine(`__VARLOCK_ENV_${i}`, chunks[i]));
    }
  }
  return lines.join('\n');
}

/**
 * Serves `content` at `filePath` for reading by miniflare.
 * On Unix: uses a FIFO (named pipe) so secrets never touch disk.
 * On Windows: falls back to a regular temp file.
 *
 * The FIFO child process writes to the pipe in a loop — each `readFileSync`
 * by wrangler/miniflare gets the content, and the child immediately starts
 * the next write so subsequent reads also work.
 */
function serveFifoOrFile(filePath: string, content: string) {
  let fifoProcess: ChildProcess | undefined;

  if (isWindows) {
    writeFileSync(filePath, content);
  } else {
    execSync(`mkfifo -m 0600 "${filePath}"`);
    // Spawn a child process that writes to the FIFO in a loop.
    // Content is passed as a base64-encoded argument instead of stdin
    // to avoid a deadlock: wrangler's readFileSync blocks the parent's
    // event loop, which would prevent stdin data from being flushed.
    const encoded = Buffer.from(content).toString('base64');
    const parentPid = process.pid;
    fifoProcess = spawn(process.execPath, [
      '-e', `
      const fs = require('fs');
      const content = Buffer.from('${encoded}', 'base64').toString();
      // Exit if the parent process dies (orphan protection).
      setInterval(() => {
        try { process.kill(${parentPid}, 0); }
        catch { process.exit(); }
      }, 2000);
      (function serve() {
        try { fs.writeFileSync(${JSON.stringify(filePath)}, content); setImmediate(serve); }
        catch { process.exit(); }
      })();
    `,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
  }

  return {
    stop() {
      fifoProcess?.kill();
    },
  };
}


// --- main plugin -----------------------------------------------------------

/**
 * Varlock Cloudflare Vite plugin — wraps `@cloudflare/vite-plugin` with
 * automatic env var injection.
 *
 * For SvelteKit projects deploying via `@sveltejs/adapter-cloudflare`, use
 * `varlockSvelteKitCloudflarePlugin` from
 * `@varlock/cloudflare-integration/sveltekit` instead — it skips
 * `@cloudflare/vite-plugin` (which doesn't support SvelteKit) and uses an
 * SSR-entry-based env loader.
 *
 * **Important:** Do not use a `.dev.vars` file alongside this plugin — varlock
 * handles env injection automatically. The plugin will throw an error if a
 * `.dev.vars` file is detected in your project root or build output.
 *
 * @example
 * ```ts
 * import { varlockCloudflareVitePlugin } from '@varlock/cloudflare-integration';
 *
 * export default defineConfig({
 *   plugins: [
 *     varlockCloudflareVitePlugin(),
 *   ],
 * });
 * ```
 */
export function varlockCloudflareVitePlugin(
  /**
   * All options from the original Cloudflare Vite plugin are supported.
   * @see https://developers.cloudflare.com/workers/vite-plugin/reference/api/
   */
  cloudflareOptions?: PluginConfig,
  // Return Array<any> instead of Array<Plugin> to avoid symlink type conflicts.
  // When this package is symlinked for local dev, TypeScript resolves `vite`'s
  // Plugin type from this package's node_modules — a different copy than the
  // consumer's — causing spurious type errors. Since Vite's `plugins` config
  // is loosely typed, Array<any> is functionally equivalent.
): Array<any> {
  // --- conflict guard ---------------------------------------------------
  // Error loudly if the user added `@cloudflare/vite-plugin` themselves.
  const conflictGuard: import('vite').Plugin = {
    name: 'varlock-cloudflare-conflict-guard',
    configResolved(config) {
      const cfPluginCount = config.plugins.filter(
        (p) => typeof p?.name === 'string' && p.name === CLOUDFLARE_PLUGIN_NAME,
      ).length;
      if (cfPluginCount > 1) {
        throw new Error(
          '[varlock] `@cloudflare/vite-plugin` is already present in your Vite plugins. '
          + 'Remove it — `varlockCloudflareVitePlugin` injects (and configures) it for you.',
        );
      }
    },
  };

  // Detect dev vs build — set by a pre-enforce plugin before the cloudflare
  // plugin evaluates its config callback.
  let isDevMode = false;
  const modeDetector: import('vite').Plugin = {
    name: 'varlock-cloudflare-mode',
    enforce: 'pre',
    config(config, env) {
      isDevMode = env.command === 'serve';

      // Error if a .dev.vars file exists — it conflicts with varlock's env management.
      const root = config.root ? path.resolve(config.root) : process.cwd();
      const devVarsPath = path.resolve(root, '.dev.vars');
      if (existsSync(devVarsPath)) {
        throw new Error(
          '[varlock] A .dev.vars file was found in your project root, which conflicts with varlock\'s env management.\n'
          + 'Remove the .dev.vars file — varlock handles env injection automatically.',
        );
      }
    },
  };

  // Merge our config callback with any user-provided config.
  const userConfig = cloudflareOptions?.config;
  const mergedConfig = (cfg: WorkerConfig) => {
    let userResult: Partial<WorkerConfig> | undefined;
    if (typeof userConfig === 'function') {
      userResult = userConfig(cfg) || undefined;
    } else if (userConfig) {
      userResult = userConfig;
    }

    // Only inject vars in dev — production gets them via varlock-wrangler deploy.
    if (!isDevMode) return userResult;

    // Single CLI call for the full graph, then extract individual vars.
    const { stdout: serializedGraph } = execSyncVarlock('load --format json-full --compact', { fullResult: true });
    let graph: { config: Record<string, { value: unknown }> };
    try {
      graph = JSON.parse(serializedGraph);
    } catch (err) {
      throw new Error(`[varlock] failed to parse config graph: ${(err as Error).message}`);
    }
    const vars: Record<string, string> = {};
    for (const key in graph.config) {
      const { value } = graph.config[key];
      if (value === undefined) continue;
      vars[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return {
      ...userResult,
      vars: {
        ...cfg.vars, ...userResult?.vars, ...vars, __VARLOCK_ENV: serializedGraph,
      },
    };
  };

  const varlockPlugin = varlockVitePlugin({
    ssrEdgeRuntime: true,
    ssrEntryModuleIds: ['\0virtual:cloudflare/worker-entry'],
    ssrEntryCode: [CLOUDFLARE_SSR_ENTRY_CODE],
  });

  const cloudflarePlugin = cloudflare({
    ...cloudflareOptions,
    config: mergedConfig,
  });

  // --- preview env injector -----------------------------------------------
  // During `vite preview`, the CF plugin reads `.dev.vars` from the build
  // output directory (next to the built wrangler.json) to populate miniflare
  // bindings. We serve env vars via a FIFO (named pipe) so secrets never
  // touch disk. This plugin's `configurePreviewServer` runs before the CF
  // plugin's because it appears earlier in the plugin array.
  let resolvedRoot = '';
  const previewEnvInjector: import('vite').Plugin = {
    name: 'varlock-cloudflare-preview-env',
    configResolved(config) {
      resolvedRoot = config.root;
    },
    configurePreviewServer(server) {
      if (!resolvedRoot) return;

      // Find the build output directory containing wrangler.json.
      // The CF plugin names environments after the worker name (e.g. "test_worker"),
      // so we scan the build output rather than guessing the environment name.
      const devVarsPath = findDevVarsPath(resolvedRoot);
      if (!devVarsPath) return;

      if (existsSync(devVarsPath)) {
        throw new Error(
          '[varlock] A .dev.vars file was found in the build output, which conflicts with varlock\'s env management.\n'
          + 'Remove your project-root .dev.vars file — varlock handles env injection automatically.',
        );
      }

      // Build dotenv-format content from the already-loaded env graph.
      // The vite plugin's module-level reloadConfig() already populated
      // varlockLoadedEnv and process.env.__VARLOCK_ENV.
      const serializedGraph = process.env.__VARLOCK_ENV;
      if (!serializedGraph || !varlockLoadedEnv) return;

      const content = formatDevVarsContent(varlockLoadedEnv, serializedGraph);

      // Write a temporary .dev.vars file for miniflare to pick up.
      // On Unix we use a FIFO (named pipe) so secrets stay in memory.
      // On Windows we fall back to a regular file.
      const fifo = serveFifoOrFile(devVarsPath, content);

      // Clean up when the preview server shuts down.
      const origClose = server.close.bind(server);
      server.close = async () => {
        fifo.stop();
        cleanupFile(devVarsPath);
        return origClose();
      };
      // Also clean up on process exit.
      const onExit = () => {
        fifo.stop();
        cleanupFile(devVarsPath);
      };
      process.on('exit', onExit);
      process.on('SIGINT', onExit);
      process.on('SIGTERM', onExit);
    },
  };

  return [
    conflictGuard,
    modeDetector,
    previewEnvInjector,
    varlockPlugin,
    // cloudflare() may return a single plugin or an array
    ...(Array.isArray(cloudflarePlugin) ? cloudflarePlugin : [cloudflarePlugin]),
  ];
}
