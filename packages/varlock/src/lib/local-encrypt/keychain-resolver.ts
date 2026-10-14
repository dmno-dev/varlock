/**
 * Built-in keychain() resolver function.
 *
 * Reads secrets from the macOS Keychain via the Swift daemon binary.
 * Always goes through the daemon to enforce biometric gating (per-TTY sessions)
 * and to make VarlockEnclave the authorized keychain accessor.
 *
 * Syntax:
 *   keychain(service="com.company.db")
 *   keychain(service="com.company.db", account="admin")
 *   keychain(service="com.company.db", keychain="System")
 *   keychain("com.company.db")          — shorthand for service
 *   keychain(prompt)                     — interactive picker, writes back reference
 */

import { createResolver, Resolver } from '../../env-graph/lib/resolver';
import { ResolutionError, SchemaError } from '../../env-graph/lib/errors';
import { getDaemonClient } from './index';
import { DaemonError } from './daemon-client';
import { writeBackValue } from './write-back';

type KeychainResolverState = {
  mode: 'get';
  itemKey: string;
  service?: string;
  account?: string;
  keychain?: string;
  field?: string;
} | {
  mode: 'prompt';
  itemKey: string;
  sourceFilePath: string | undefined;
};

function writeBackKeychainRef(
  itemKey: string,
  ref: { service: string; account?: string; keychain?: string },
  sourceFilePath: string | undefined,
) {
  // Use positional shorthand when only service is needed, named args when disambiguating
  let argsStr: string;
  if (!ref.account && !ref.keychain) {
    argsStr = `"${ref.service}"`;
  } else {
    const parts: Array<string> = [`service="${ref.service}"`];
    if (ref.account) parts.push(`account="${ref.account}"`);
    if (ref.keychain) parts.push(`keychain="${ref.keychain}"`);
    argsStr = parts.join(', ');
  }

  writeBackValue(itemKey, `keychain(${argsStr})`, sourceFilePath);
}

function shellQuote(value: string) {
  return /^[\w%+,./:=@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function formatRefArgs(state: { service?: string; account?: string; keychain?: string }) {
  return [
    state.service ? `service="${state.service}"` : null,
    state.account ? `account="${state.account}"` : null,
    state.keychain ? `keychain="${state.keychain}"` : null,
  ].filter(Boolean).join(', ');
}

function formatRefFlags(state: { service?: string; account?: string; keychain?: string }) {
  return [
    state.service ? `--service ${shellQuote(state.service)}` : null,
    state.account ? `--account ${shellQuote(state.account)}` : null,
    state.keychain ? `--keychain ${shellQuote(state.keychain)}` : null,
  ].filter(Boolean).join(' ');
}

export const KeychainResolver: typeof Resolver = createResolver<KeychainResolverState>({
  name: 'keychain',
  label: 'Read from macOS Keychain',
  icon: 'mdi:key-chain',
  impliesSensitive: true,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
  },
  process(): KeychainResolverState {
    if (process.platform !== 'darwin') {
      throw new SchemaError('keychain() is only supported on macOS');
    }

    // Check for prompt mode: keychain(prompt) or keychain(prompt=1)
    const promptArg = this.objArgs?.prompt;
    const isPromptPositional = this.arrArgs?.length === 1
      && this.arrArgs[0]?.isStatic
      && this.arrArgs[0].staticValue === 'prompt';

    if (promptArg || isPromptPositional) {
      const parent = (this as any).parent;
      const itemKey = parent?.key || 'unknown';
      const dataSource = this.dataSource as any;
      const sourceFilePath = dataSource?.fullPath as string | undefined;
      return { mode: 'prompt', itemKey, sourceFilePath };
    }

    const itemKey: string = (this as any).parent?.key || 'unknown';

    // Named args mode: keychain(service="...", account="...", keychain="...", field="...")
    const serviceArg = this.objArgs?.service;
    const accountArg = this.objArgs?.account;
    const keychainArg = this.objArgs?.keychain;
    const fieldArg = this.objArgs?.field;

    const account = accountArg?.isStatic ? accountArg.staticValue as string : undefined;
    const keychain = keychainArg?.isStatic ? keychainArg.staticValue as string : undefined;
    const field = fieldArg?.isStatic ? fieldArg.staticValue as string : undefined;

    if (serviceArg) {
      if (!serviceArg.isStatic || typeof serviceArg.staticValue !== 'string') {
        throw new SchemaError('keychain() service must be a static string');
      }
      return {
        mode: 'get', itemKey, service: serviceArg.staticValue, account, keychain, field,
      };
    }

    // account-only lookup: keychain(account="admin@corp.com", field="account")
    if (accountArg) {
      return {
        mode: 'get', itemKey, account, keychain, field,
      };
    }

    // Positional shorthand: keychain("com.company.service")
    if (this.arrArgs?.length === 1 && this.arrArgs[0]?.isStatic) {
      const value = this.arrArgs[0].staticValue;
      if (typeof value !== 'string') {
        throw new SchemaError('keychain() expects a string service name');
      }
      return {
        mode: 'get', itemKey, service: value, field,
      };
    }

    throw new SchemaError(
      'keychain() requires service name, account, or prompt mode. '
      + 'Usage: keychain(service="com.example"), keychain("com.example"), or keychain(prompt)',
    );
  },
  async resolve(state: KeychainResolverState) {
    const client = getDaemonClient();

    if (state.mode === 'get') {
      const refFlags = formatRefFlags(state);
      try {
        return await client.keychainGet({
          service: state.service,
          account: state.account,
          keychain: state.keychain,
          field: state.field,
        });
      } catch (err) {
        const code = err instanceof DaemonError ? err.code : undefined;

        if (code === 'itemNotFound') {
          // Creating needs a fully specified ref: `set` writes service+account to the default keychain
          const canCreate = !!state.service && !!state.account && !state.keychain && !state.field;
          throw new ResolutionError('Keychain item not found', {
            tip: canCreate
              ? [
                'Save a value for it with:',
                `  varlock keychain set ${state.itemKey} ${refFlags}`,
              ].join('\n')
              : [
                `Looked for: ${formatRefArgs(state)}`,
                'Find the right item with `varlock keychain list`, or pick one with keychain(prompt).',
              ].join('\n'),
          });
        }

        // Unknown-field errors also arrive as accessDenied, and fix-access cannot help those
        if (code === 'accessDenied' && !state.field) {
          throw new ResolutionError(`Varlock is not allowed to read this Keychain item: ${(err as Error).message}`, {
            tip: [
              'Grant access with:',
              `  varlock keychain fix-access ${refFlags}`,
              'or choose "Always Allow" the next time macOS asks.',
            ].join('\n'),
          });
        }

        if (code === 'ambiguousMatch') {
          throw new ResolutionError(`More than one Keychain item matches: ${(err as Error).message}`, {
            tip: 'Add account="..." to keychain() to pick one. `varlock keychain list` shows the candidates.',
          });
        }

        throw new ResolutionError(
          `Failed to read keychain item: ${err instanceof Error ? err.message : err}`,
          { tip: `Looked for: ${formatRefArgs(state)}` },
        );
      }
    }

    // Prompt mode: show native picker, write back reference
    const { itemKey, sourceFilePath } = state;

    const selected = await client.keychainPick({ itemKey });
    if (!selected) {
      throw new ResolutionError('Keychain item selection was cancelled', {
        tip: 'Run varlock again and select an item, or use keychain(service="...") with an explicit service name',
      });
    }

    writeBackKeychainRef(itemKey, selected, sourceFilePath);

    // Now fetch the actual value
    try {
      return await client.keychainGet({
        service: selected.service,
        account: selected.account,
        keychain: selected.keychain,
      });
    } catch (err) {
      throw new ResolutionError(
        `Selected keychain item but failed to read value: ${err instanceof Error ? err.message : err}`,
        {
          tip: 'The item reference has been written to your config. Try running varlock again.',
        },
      );
    }
  },
});
