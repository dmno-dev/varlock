import fs from 'node:fs';
import ansis from 'ansis';
import { define } from 'gunshi';
import { isCancel } from '@clack/prompts';

import { CacheStore } from '../../lib/cache';
import { formatTimeAgo, formatDuration } from '../../lib/formatting';
import * as localEncrypt from '../../lib/local-encrypt';
import { select, confirm } from '../helpers/prompts';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'cache',
  description: 'Manage the varlock cache',
  args: {
    plugin: {
      type: 'string',
      description: 'Clear cache for a specific plugin only',
    },
  },
  examples: `
Manage the encrypted value cache used by cache() and plugin authors.

Examples:
  varlock cache                    # Interactive cache browser
  varlock cache clear              # Clear all cache entries
  varlock cache clear --plugin 1password  # Clear cache for specific plugin
`.trim(),
});

type CacheEntry = { key: string; cachedAt: number; expiresAt: number };

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
    const firstColon = entry.key.indexOf(':');
    const secondColon = firstColon >= 0 ? entry.key.indexOf(':', firstColon + 1) : -1;
    const prefix = secondColon >= 0 ? entry.key.slice(0, secondColon) : entry.key.slice(0, firstColon);
    groups[prefix] ??= [];
    groups[prefix].push(entry);
  }
  return groups;
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const positionals = (ctx.positionals ?? []).slice(ctx.commandPath?.length ?? 0);
  const action = positionals[0];

  if (!localEncrypt.keyExists()) {
    console.log(ansis.gray('  No encryption key found — cache is not active.'));
    return;
  }

  const store = new CacheStore();

  // non-interactive clear
  if (action === 'clear') {
    const pluginName = ctx.values.plugin;
    let count: number;

    if (pluginName) {
      count = store.clearByPrefix(`plugin:${pluginName}:`);
      console.log(`  Cleared ${count} cache entries for plugin "${pluginName}"`);
    } else {
      count = store.clearAll();
      console.log(`  Cleared ${count} cache entries`);
    }
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
      const label = prefix.startsWith('plugin:')
        ? `${ansis.magenta(`[${prefix.replace('plugin:', '')}]`)} plugin cache`
        : `${ansis.cyan('[resolver]')} cached values`;
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
      const count = store.clearAll();
      console.log(`  Cleared ${count} entries`);
      return;
    }

    if (typeof selected === 'string' && selected.startsWith('group:')) {
      const prefix = selected.replace('group:', '');
      const groupLabel = prefix.startsWith('plugin:')
        ? `${prefix.replace('plugin:', '')} plugin`
        : 'resolver cache';

      // show all entries in the group with clear-all and delete options
      while (true) {
        const current = store.listEntries().filter((e) => {
          const k = e.key;
          const fc = k.indexOf(':');
          const sc = fc >= 0 ? k.indexOf(':', fc + 1) : -1;
          const p = sc >= 0 ? k.slice(0, sc) : k.slice(0, fc);
          return p === prefix;
        });
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
          store.clearByPrefix(`${prefix}:`);
          console.log(ansis.gray(`  Cleared ${current.length} entries`));
          break;
        }

        // delete individual entry
        const confirmed = await confirm({
          message: `Delete "${entrySelected}"?`,
          initialValue: true,
        });
        if (isCancel(confirmed) || !confirmed) continue;
        store.delete(entrySelected);
        console.log(ansis.gray('  Deleted'));
      }
    }
  }
};
