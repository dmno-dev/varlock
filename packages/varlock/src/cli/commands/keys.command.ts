import ansis from 'ansis';
import { define } from 'gunshi';

import * as localEncrypt from '../../lib/local-encrypt';
import { trackCommand } from '../helpers/telemetry';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';

function printKeyList() {
  const backend = localEncrypt.getBackendInfo();
  const keys = localEncrypt.listKeyDetails();

  console.log(`Backend: ${backend.type} (${backend.hardwareBacked ? 'hardware-backed' : 'file-based'})`);
  console.log(`Presence gate on this machine: ${backend.biometricAvailable ? 'available' : 'not available'}`);
  console.log('');

  if (!keys.length) {
    console.log(ansis.gray('No local encryption keys yet — one is created automatically on first use,'));
    console.log(ansis.gray('or create one explicitly with `varlock keys create <name>`'));
    return;
  }

  const gateLabelFor = (key: { requireAuth: boolean }): string => {
    if (backend.type === 'file') return ansis.gray('n/a (file backend has no gate)');
    if (!key.requireAuth) return ansis.gray('unattended (created with --no-auth)');
    if (backend.biometricAvailable) return ansis.green('prompts on decrypt');
    return ansis.yellow('prompts on decrypt (no gate on this machine — decrypts unattended)');
  };

  for (const key of keys) {
    const gateLabel = gateLabelFor(key);
    console.log(`  ${ansis.cyan(key.keyId)}`);
    console.log(`    presence: ${gateLabel}`);
    if (key.protection) console.log(`    protection: ${key.protection}`);
    if (key.createdAt) console.log(`    created: ${key.createdAt}`);
  }
}

// --- `varlock keys list` ------------------------------------------------------

const listCommand = define({
  name: 'list',
  description: 'List local encryption keys and their presence-gate settings',
  run: async () => {
    await trackCommand('keys list', { command: 'keys list' });
    printKeyList();
  },
});

// --- `varlock keys create` ------------------------------------------------------

const createCommand = define({
  name: 'create',
  description: 'Create a new local encryption key',
  args: {
    name: {
      type: 'positional',
      description: 'Key id (e.g. "ci", "deploy") — becomes part of the key file name',
    },
    'no-auth': {
      type: 'boolean',
      description: 'Opt this key out of presence verification (Touch ID / Windows Hello / polkit) — for unattended use (servers, CI)',
    },
  },
  examples: `
  varlock keys create deploy               # new key, prompts on decrypt where a gate is available
  varlock keys create ci --no-auth         # new key that always decrypts unattended
`.trim(),
  run: async (ctx) => {
    await trackCommand('keys create', { command: 'keys create' });

    const keyId = String(ctx.values.name || '');
    if (!keyId) {
      throw new CliExitError('Missing key name', { suggestion: 'Usage: varlock keys create <name> [--no-auth]' });
    }
    if (!localEncrypt.isValidKeyId(keyId)) {
      throw new CliExitError(`"${keyId}" is not a valid key id`, {
        suggestion: localEncrypt.KEY_ID_REQUIREMENTS_MESSAGE,
      });
    }
    if (localEncrypt.keyExists(keyId)) {
      throw new CliExitError(`Key "${keyId}" already exists`, {
        suggestion: 'Presence settings are fixed at creation — to change them, create a new key and re-encrypt your values.',
      });
    }

    const requireAuth = !ctx.values['no-auth'];
    const backend = localEncrypt.getBackendInfo();

    try {
      await localEncrypt.generateKey(keyId, { requireAuth });
    } catch (err) {
      throw new CliExitError(`Failed to create key: ${err instanceof Error ? err.message : err}`);
    }

    console.log(`Created key ${ansis.cyan(keyId)} (${backend.type}${backend.hardwareBacked ? ', hardware-backed' : ''})`);
    if (backend.type === 'file') {
      console.log(ansis.gray('The file backend has no presence gate — decrypts are always unattended.'));
    } else if (!requireAuth) {
      console.log(ansis.gray('This key decrypts unattended (no presence prompt) — suitable for headless/CI use.'));
      console.log(ansis.gray('It still protects values at rest, but not against a process already running as your user.'));
    } else if (!backend.biometricAvailable) {
      console.log(ansis.yellow('This key will prompt for presence when a gate is available, but this machine has none configured — decrypts are unattended here.'));
    }

    console.log('');
    console.log('Use it via:');
    console.log(`  varlock encrypt --key-id ${keyId}                     # encrypt a value with this key`);
    console.log(`  # @defaultLocalKey=${keyId}                           # or make it the project default (.env.schema header)`);
  },
});

// --- `varlock keys` (parent) -----------------------------------------------

export const commandSpec = define({
  name: 'keys',
  description: 'Manage device-local encryption keys used by varlock("local:...") values',
  subCommands: {
    list: listCommand,
    create: createCommand,
  },
  examples: `
Manage the device-local encryption keys behind varlock("local:...") values and the encrypted cache.

Keys are device-bound (Secure Enclave / TPM / DPAPI) and never leave the machine.
Each key records whether decrypting requires presence verification (Touch ID /
Windows Hello / polkit) — chosen at creation and fixed for the life of the key.

Examples:
  varlock keys                       # list keys (same as \`varlock keys list\`)
  varlock keys create deploy         # create a key that prompts on decrypt
  varlock keys create ci --no-auth   # create a key for unattended use
`.trim(),
});

/** Default `varlock keys` with no subcommand: same as list */
export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async () => {
  printKeyList();
};
