import fs from 'node:fs';
import ansis from 'ansis';
import { define } from 'gunshi';

import { CacheStore } from '../../lib/cache';
import * as localEncrypt from '../../lib/local-encrypt';
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
  varlock cache                    # Show cache status
  varlock cache clear              # Clear all cache entries
  varlock cache clear --plugin 1password  # Clear cache for specific plugin
`.trim(),
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const positionals = (ctx.positionals ?? []).slice(ctx.commandPath?.length ?? 0);
  const action = positionals[0] ?? 'status';

  if (!localEncrypt.keyExists()) {
    console.log(ansis.gray('  No encryption key found — cache is not active.'));
    return;
  }

  const store = new CacheStore();

  if (action === 'status') {
    const stats = store.getStats();
    const filePath = store.getFilePath();

    console.log('');
    console.log(ansis.bold('  Cache status'));
    console.log(`    ${ansis.gray('File:')} ${filePath}`);

    if (fs.existsSync(filePath)) {
      const fileSize = fs.statSync(filePath).size;
      const sizeStr = fileSize < 1024 ? `${fileSize}B` : `${(fileSize / 1024).toFixed(1)}KB`;
      console.log(`    ${ansis.gray('Size:')} ${sizeStr}`);
    }

    console.log(`    ${ansis.gray('Entries:')} ${stats.total} (${stats.expired} expired)`);

    if (Object.keys(stats.byPrefix).length > 0) {
      console.log('');
      console.log(ansis.bold('  Entries by type'));
      for (const [prefix, count] of Object.entries(stats.byPrefix)) {
        console.log(`    ${ansis.cyan(prefix)}: ${count}`);
      }
    }
    console.log('');
  } else if (action === 'clear') {
    const pluginName = ctx.values.plugin;
    let count: number;

    if (pluginName) {
      count = store.clearByPrefix(`plugin:${pluginName}:`);
      console.log(`  Cleared ${count} cache entries for plugin "${pluginName}"`);
    } else {
      count = store.clearAll();
      console.log(`  Cleared ${count} cache entries`);
    }
  } else {
    console.log(ansis.red(`  Unknown action: ${action}`));
    console.log('  Available actions: status, clear');
  }
};
