import { define, lazy } from 'gunshi';

// --- `varlock cache status` -------------------------------------------------

export const statusCommandSpec = define({
  name: 'status',
  description: 'Print a cache status summary (non-interactive)',
});

// --- `varlock cache clear` --------------------------------------------------

export const clearCommandSpec = define({
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
});

// --- `varlock cache` (parent) -----------------------------------------------

export const commandSpec = define({
  name: 'cache',
  description: 'Manage the varlock cache',
  subCommands: {
    status: lazy(async () => (await import('./cache.command')).statusCommandFn, statusCommandSpec),
    clear: lazy(async () => (await import('./cache.command')).clearCommandFn, clearCommandSpec),
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
