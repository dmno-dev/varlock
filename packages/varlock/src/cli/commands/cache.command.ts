import fs from 'node:fs';
import path from 'node:path';
import ansis from 'ansis';
import { define } from 'gunshi';
import { isCancel } from '@clack/prompts';

import { CacheStore, createEnvKeyCacheStore, getCacheEnvKey } from '../../lib/cache';
import { groupKeyPrefix } from '../../lib/cache/cache-store';
import { formatTimeAgo, formatDuration } from '../../lib/formatting';
import * as localEncrypt from '../../lib/local-encrypt';
import { select, confirm } from '../helpers/prompts';
import { trackCommand } from '../helpers/telemetry';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

type CacheEntry = { key: string; cachedAt: number; expiresAt: number };

function formatResolverSourcePath(sourcePath: string): string {
  const homeDir = process.env.HOME;
  if (homeDir && sourcePath.startsWith(`${homeDir}/`)) {
    return `~/${sourcePath.slice(homeDir.length + 1)}`;
  }
  const relToCwd = path.relative(process.cwd(), sourcePath);
  if (relToCwd && !relToCwd.startsWith('..') && !path.isAbsolute(relToCwd)) {
    return `./${relToCwd}`;
  }
  return sourcePath;
}

function getGroupLabel(prefix: string): string {
  if (prefix.startsWith('plugin:')) {
    return `${ansis.magenta(`[${prefix.replace('plugin:', '')}]`)} plugin cache`;
  }

  if (prefix === 'resolver:custom') {
    return `${ansis.cyan('[resolver:custom]')} explicit keys`;
  }

  if (prefix.startsWith('resolver:')) {
    const sourcePath = prefix.slice('resolver:'.length);
    return `${ansis.cyan('[resolver]')} ${ansis.gray(formatResolverSourcePath(sourcePath))}`;
  }

  return prefix;
}

function formatEntryLabel(entry: CacheEntry): string {
  const ttlMs = entry.expiresAt - entry.cachedAt;
  const isForever = ttlMs > 50 * 365.25 * 86_400_000;
  const ttlStr = isForever ? 'forever' : formatDuration(ttlMs);
  const agoStr = formatTimeAgo(entry.cachedAt);

  const parts = entry.key.split(':');
  let line1: string;
  const line2 = ansis.gray(`  ttl: ${ttlStr} · cached ${agoStr}`);

  if (parts[0] === 'plugin') {
    const pluginName = parts[1];
    const rest = parts.slice(2).join(':');
    line1 = `${ansis.magenta(`[${pluginName}]`)} ${rest}`;
  } else if (parts[0] === 'resolver' && parts[1] === 'custom') {
    line1 = `${ansis.cyan('[custom]')} ${parts.slice(2).join(':')}`;
  } else if (parts[0] === 'resolver') {
    const itemKey = parts[2];
    const resolverText = parts.slice(3).join(':');
    line1 = `${ansis.cyan(itemKey)} ${ansis.gray('=')} ${resolverText}`;
  } else {
    line1 = entry.key;
  }

  return `${line1}\n     ${line2}`;
}

/** Group entries by their prefix (e.g., "plugin:1pass", "resolver") */
function groupEntries(entries: Array<CacheEntry>): Record<string, Array<CacheEntry>> {
  const groups: Record<string, Array<CacheEntry>> = {};
  for (const entry of entries) {
    const prefix = groupKeyPrefix(entry.key);
    groups[prefix] ??= [];
    groups[prefix].push(entry);
  }
  return groups;
}

/** Print a non-interactive cache status summary. Safe to run in CI. */
function printStatus(store: CacheStore): void {
  const stats = store.getStats();
  const filePath = store.getFilePath();
  const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const sizeStr = fileSize < 1024 ? `${fileSize} B` : `${(fileSize / 1024).toFixed(1)} KB`;

  console.log(`\n  ${ansis.bold('Varlock cache')}`);
  console.log(`  Location:     ${ansis.gray(filePath)}`);
  console.log(`  File size:    ${sizeStr}`);
  console.log(`  Total entries: ${stats.total}${stats.expired ? ansis.gray(` (${stats.expired} expired)`) : ''}`);
  if (Object.keys(stats.byPrefix).length > 0) {
    console.log('  By group:');
    for (const [prefix, count] of Object.entries(stats.byPrefix)) {
      console.log(`    ${prefix.padEnd(30)} ${count}`);
    }
  }
  console.log('');
}

const isInteractive = () => process.stdout.isTTY && process.stdin.isTTY;

/**
 * Resolve the cache store to operate on. Returns `null` (after logging) when no
 * cache is active — e.g. an invalid `_VARLOCK_CACHE_KEY` or no local key present.
 */
function resolveStore(): CacheStore | null {
  // when an env-provided key is active (e.g. CI), manage that key's cache file
  const envKey = getCacheEnvKey();
  if (envKey) {
    try {
      return createEnvKeyCacheStore(envKey);
    } catch (err) {
      console.error(ansis.red(`_VARLOCK_CACHE_KEY is set but invalid: ${err instanceof Error ? err.message : err}`));
      process.exitCode = 1;
      return null;
    }
  }

  if (!localEncrypt.keyExists()) {
    console.log(ansis.gray('  No encryption key found — cache is not active.'));
    return null;
  }
  return new CacheStore();
}

// --- `varlock cache status` -------------------------------------------------

const statusCommand = define({
  name: 'status',
  description: 'Print a cache status summary (non-interactive)',
  run: async () => {
    await trackCommand('cache status', { command: 'cache status' });
    const store = resolveStore();
    if (!store) return;
    printStatus(store);
  },
});

// --- `varlock cache clear` --------------------------------------------------

const clearCommand = define({
  name: 'clear',
  description: 'Clear cache entries',
  args: {
    plugin: {
      type: 'string',
      description: 'Clear cache for a specific plugin only',
    },
    yes: {
      type: 'boolean',
      short: 'y',
      description: 'Skip confirmation prompts (required when non-interactive)',
    },
  },
  examples: `
  varlock cache clear --yes                       # Clear all entries (no prompt)
  varlock cache clear --plugin 1password --yes    # Clear cache for a specific plugin
`.trim(),
  run: async (ctx) => {
    await trackCommand('cache clear', { command: 'cache clear' });

    const store = resolveStore();
    if (!store) return;

    const pluginName = ctx.values.plugin;
    const skipConfirm = ctx.values.yes;
    const target = pluginName
      ? `cache entries for plugin "${pluginName}"`
      : 'cache entries';

    // require either --yes or an interactive confirm
    if (!skipConfirm) {
      if (!isInteractive()) {
        console.error(ansis.red(`Refusing to clear ${target} without confirmation.`));
        console.error('  Re-run with --yes to confirm, or run interactively.');
        process.exitCode = 1;
        return;
      }
      const confirmed = await confirm({
        message: `Clear all ${target}? This cannot be undone.`,
        initialValue: false,
      });
      if (isCancel(confirmed) || !confirmed) {
        console.log(ansis.gray('  Aborted.'));
        return;
      }
    }

    try {
      const count = pluginName
        ? await store.clearByPrefix(`plugin:${pluginName}:`)
        : await store.clearAll();
      console.log(`  Cleared ${count} ${target}`);
    } catch (err) {
      console.error(ansis.red(`Failed to clear ${target}: ${err instanceof Error ? err.message : err}`));
      process.exitCode = 1;
    }
  },
});

// --- `varlock cache` (parent) -----------------------------------------------

export const commandSpec = define({
  name: 'cache',
  description: 'Manage the varlock cache',
  subCommands: {
    status: statusCommand,
    clear: clearCommand,
  },
  examples: `
Manage the encrypted value cache used by cache() and plugin authors.

Examples:
  varlock cache                                   # Interactive cache browser (or status summary if non-TTY)
  varlock cache status                            # Print cache status summary (non-interactive)
  varlock cache clear --yes                       # Clear all entries (no prompt)
  varlock cache clear --plugin 1password --yes    # Clear cache for a specific plugin
`.trim(),
});

/**
 * Default `varlock cache` with no subcommand: interactive browser when on a TTY,
 * otherwise a non-interactive status summary (safe for CI).
 */
export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async () => {
  const store = resolveStore();
  if (!store) return;

  if (!isInteractive()) {
    printStatus(store);
    return;
  }

  // interactive mode (default)
  while (true) {
    const entries = store.listEntries();

    if (entries.length === 0) {
      console.log(ansis.gray('\n  Cache is empty.\n'));
      return;
    }

    const groups = groupEntries(entries);
    const filePath = store.getFilePath();
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const sizeStr = fileSize < 1024 ? `${fileSize}B` : `${(fileSize / 1024).toFixed(1)}KB`;
    console.log(`\n  ${ansis.bold(`${entries.length} cached entries`)} ${ansis.gray(`(${sizeStr})`)}`);

    // build top-level menu: one option per group + global actions
    const options: Array<{ value: string; label: string }> = [];

    for (const [prefix, items] of Object.entries(groups)) {
      const label = getGroupLabel(prefix);
      options.push({
        value: `group:${prefix}`,
        label: `${label} ${ansis.gray(`(${items.length} entries)`)}`,
      });
    }

    options.push({ value: '__clear_all__', label: ansis.red(`Clear all ${entries.length} entries`) });
    options.push({ value: '__exit__', label: ansis.gray('Exit') });

    const selected = await select({
      message: 'Select a group to browse or an action:',
      options,
    });

    if (isCancel(selected) || selected === '__exit__') return;

    if (selected === '__clear_all__') {
      const confirmed = await confirm({
        message: `Clear all ${entries.length} cache entries?`,
        initialValue: false,
      });
      if (isCancel(confirmed) || !confirmed) continue;
      const count = await store.clearAll();
      console.log(`  Cleared ${count} entries`);
      return;
    }

    if (typeof selected === 'string' && selected.startsWith('group:')) {
      const prefix = selected.replace('group:', '');
      const groupLabel = getGroupLabel(prefix);

      // show all entries in the group with clear-all and delete options
      while (true) {
        const current = store.listEntries().filter((e) => groupKeyPrefix(e.key) === prefix);
        if (current.length === 0) {
          console.log(ansis.gray('  No entries remaining in this group.'));
          break;
        }

        const entryOptions = [
          ...current.map((entry) => ({
            value: entry.key,
            label: formatEntryLabel(entry),
          })),
          { value: '__clear_group__', label: ansis.red(`Clear all ${current.length} entries`) },
          { value: '__back__', label: ansis.gray('← Back') },
        ];

        const entrySelected = await select({
          message: `${groupLabel} — ${current.length} entries:`,
          options: entryOptions,
        });

        if (isCancel(entrySelected) || entrySelected === '__back__') break;

        if (entrySelected === '__clear_group__') {
          const confirmed = await confirm({
            message: `Clear all ${current.length} entries in "${prefix}"?`,
            initialValue: false,
          });
          if (isCancel(confirmed) || !confirmed) continue;
          await store.clearByPrefix(`${prefix}:`);
          console.log(ansis.gray(`  Cleared ${current.length} entries`));
          break;
        }

        // delete individual entry
        const confirmed = await confirm({
          message: `Delete "${entrySelected}"?`,
          initialValue: true,
        });
        if (isCancel(confirmed) || !confirmed) continue;
        await store.delete(entrySelected);
        console.log(ansis.gray('  Deleted'));
      }
    }
  }
};
