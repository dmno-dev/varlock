import { define, lazy } from 'gunshi';

// --- `varlock keychain list` ------------------------------------------------

export const listCommandSpec = define({
  name: 'list',
  description: 'List matching macOS Keychain items (metadata only)',
  args: {
    query: {
      type: 'positional',
      required: false,
      description: 'Filter items by service name',
    },
    keychain: {
      type: 'string',
      description: 'Keychain name to search, such as Login or System',
    },
  },
});

// --- `varlock keychain fix-access` ------------------------------------------

export const fixAccessCommandSpec = define({
  name: 'fix-access',
  description: "Grant Varlock's helper access to existing keychain() items",
  args: {
    service: {
      type: 'string',
      default: 'varlock',
      description: 'Keychain service name (default: varlock)',
    },
    account: {
      type: 'string',
      description: 'Keychain account name',
    },
    keychain: {
      type: 'string',
      description: 'Keychain name to search, such as Login or System',
    },
    path: {
      type: 'string',
      description: 'Env file to fix access for every explicit keychain() ref',
    },
  },
});

// --- `varlock keychain set` -------------------------------------------------

export const setCommandSpec = define({
  name: 'set',
  description: 'Store a secret in macOS Keychain and optionally write a keychain() ref',
  args: {
    key: {
      type: 'positional',
      required: false,
      description: 'Env var key to store (used to generate the account name and ref)',
    },
    service: {
      type: 'string',
      default: 'varlock',
      description: 'Keychain service name (default: varlock)',
    },
    account: {
      type: 'string',
      description: 'Keychain account name (defaults to <project>:<profile>:<KEY>)',
    },
    profile: {
      type: 'string',
      default: 'local',
      description: 'Profile name used in generated account names',
    },
    project: {
      type: 'string',
      description: 'Project slug used in generated account names (default: current directory name)',
    },
    'write-to': {
      type: 'string',
      description: 'Env file to write the keychain() ref to',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing Keychain item and env ref',
    },
  },
});

// --- `varlock keychain import` ----------------------------------------------

export const importCommandSpec = define({
  name: 'import',
  description: 'Migrate sensitive plaintext values from an env file into macOS Keychain',
  args: {
    file: {
      type: 'positional',
      required: false,
      description: 'Plaintext env file to import secrets from',
    },
    'write-to': {
      type: 'string',
      description: 'Write refs to a different env file instead of editing the source in place',
    },
    service: {
      type: 'string',
      default: 'varlock',
      description: 'Keychain service name (default: varlock)',
    },
    profile: {
      type: 'string',
      default: 'local',
      description: 'Profile name used in generated account names',
    },
    project: {
      type: 'string',
      description: 'Project slug used in generated account names (default: current directory name)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing Keychain items (and refs in a --write-to target)',
    },
  },
});

// --- `varlock keychain` (parent) --------------------------------------------

export const commandSpec = define({
  name: 'keychain',
  description: 'Manage macOS Keychain items used by keychain()',
  subCommands: {
    list: lazy(async () => (await import('./keychain.command')).listCommandFn, listCommandSpec),
    'fix-access': lazy(async () => (await import('./keychain.command')).fixAccessCommandFn, fixAccessCommandSpec),
    set: lazy(async () => (await import('./keychain.command')).setCommandFn, setCommandSpec),
    import: lazy(async () => (await import('./keychain.command')).importCommandFn, importCommandSpec),
  },
  examples: `
Examples:
  varlock keychain list
  varlock keychain fix-access --account "my-project:jb:API_KEY"
  varlock keychain fix-access --path .env.jb
  varlock keychain import .env --profile jb            # migrate .env in place
  varlock keychain import .env --profile jb --write-to .env.jb
  varlock keychain set API_KEY --profile jb --write-to .env.jb
`.trim(),
});
