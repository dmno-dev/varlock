import fs from 'node:fs';
import path from 'node:path';
import ansis from 'ansis';
import { define } from 'gunshi';
import { isCancel } from '@clack/prompts';
import {
  parseEnvSpecDotEnvFile,
  ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecStaticValue,
} from '@env-spec/parser';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { writeBackValue } from '../../lib/local-encrypt/write-back';
import { getDaemonClient } from '../../lib/local-encrypt';
import { DaemonError } from '../../lib/local-encrypt/daemon-client';
import { CliExitError } from '../helpers/exit-error';
import { password } from '../helpers/prompts';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

type KeychainRef = {
  key?: string;
  service: string;
  account?: string;
  keychain?: string;
};

export const commandSpec = define({
  name: 'keychain',
  description: 'Manage macOS Keychain items used by keychain()',
  args: {
    service: {
      type: 'string',
      description: 'Keychain service name (default: varlock)',
      default: 'varlock',
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
      description: 'Path to an env file containing keychain() refs',
    },
    from: {
      type: 'string',
      description: 'Plaintext env file to import from',
    },
    write: {
      type: 'string',
      description: 'Env file to write keychain() refs to',
    },
    profile: {
      type: 'string',
      description: 'Profile name used in generated account names',
      default: 'local',
    },
    project: {
      type: 'string',
      description: 'Project slug used in generated account names (default: current directory name)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing Keychain items and env refs',
    },
  },
  examples: `
Examples:
  varlock keychain list
  varlock keychain fix-access --account "my-project:jb:API_KEY"
  varlock keychain fix-access --path .env.jb
  varlock keychain import --from .env --profile jb --write .env.jb
  varlock keychain set API_KEY --profile jb --write .env.jb
`.trim(),
});

function assertMacOS() {
  if (process.platform !== 'darwin') {
    throw new CliExitError('varlock keychain is only supported on macOS');
  }
}

function quoteEnvString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function formatKeychainRef(ref: KeychainRef): string {
  const parts = [`service=${quoteEnvString(ref.service)}`];
  if (ref.account) parts.push(`account=${quoteEnvString(ref.account)}`);
  if (ref.keychain) parts.push(`keychain=${quoteEnvString(ref.keychain)}`);
  return `keychain(${parts.join(', ')})`;
}

function getGeneratedAccount(project: string, profile: string, key: string): string {
  return `${project}:${profile}:${key}`;
}

function getStaticString(value: unknown): string | undefined {
  if (value instanceof ParsedEnvSpecStaticValue && typeof value.value === 'string') {
    return value.value;
  }
  return undefined;
}

export function isKeychainItemNotFoundError(error: unknown): boolean {
  return error instanceof DaemonError && error.code === 'itemNotFound';
}

export function extractKeychainRefFromCall(key: string, call: ParsedEnvSpecFunctionCall): KeychainRef | undefined {
  if (call.name !== 'keychain') return undefined;

  let service: string | undefined;
  let account: string | undefined;
  let keychain: string | undefined;

  for (const arg of call.data.args.values) {
    if (arg instanceof ParsedEnvSpecStaticValue) {
      const value = getStaticString(arg);
      if (value && value !== 'prompt' && !service) service = value;
      continue;
    }

    if (!(arg instanceof ParsedEnvSpecKeyValuePair)) continue;

    const value = getStaticString(arg.value);
    if (typeof value !== 'string') continue;

    if (arg.key === 'service') service = value;
    if (arg.key === 'account') account = value;
    if (arg.key === 'keychain') keychain = value;
  }

  if (!service) return undefined;
  return {
    key, service, account, keychain,
  };
}

export function extractKeychainRefsFromFile(filePath: string): Array<KeychainRef> {
  const contents = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseEnvSpecDotEnvFile(contents);
  const refs: Array<KeychainRef> = [];

  for (const item of parsed.configItems) {
    if (item.value instanceof ParsedEnvSpecFunctionCall) {
      const ref = extractKeychainRefFromCall(item.key, item.value);
      if (ref) refs.push(ref);
    }
  }

  return refs;
}

function appendEnvRef(filePath: string, key: string, ref: string) {
  let current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  if (current.length > 0 && !current.endsWith('\n')) current += '\n';
  current += `${key}=${ref}\n`;
  fs.writeFileSync(filePath, current);
}

function getExistingEnvKeys(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  const parsed = parseEnvSpecDotEnvFile(fs.readFileSync(filePath, 'utf-8'));
  return new Set(parsed.configItems.map((item) => item.key));
}

export function getSensitivePlaintextImportValue(
  schemaItem: { isSensitive?: boolean; defs?: Array<{ source?: { type?: string } }> } | undefined,
  value: unknown,
): string | undefined {
  const hasSchemaDefinition = schemaItem?.defs?.some((def) => def.source?.type === 'schema');
  if (!schemaItem?.isSensitive || !hasSchemaDefinition) return undefined;
  if (!(value instanceof ParsedEnvSpecStaticValue)) return undefined;
  const unescapedValue = value.unescapedValue;
  if (typeof unescapedValue !== 'string' || unescapedValue === '') return undefined;
  return unescapedValue;
}

function writeEnvRef(filePath: string, key: string, ref: string, force: boolean) {
  const existingKeys = getExistingEnvKeys(filePath);
  if (!existingKeys.has(key)) {
    appendEnvRef(filePath, key, ref);
    return;
  }

  if (!force) {
    throw new CliExitError(`Refusing to overwrite ${key} in ${filePath}`, {
      suggestion: 'Re-run with --force to overwrite existing env refs.',
    });
  }

  const result = writeBackValue(key, ref, filePath);
  if (!result.updated) {
    throw new CliExitError(`Failed to update ${key} in ${filePath}`);
  }
}

export function assertKeychainImportSchemaPresent(envGraph: {
  sortedDataSources?: Array<{ type?: string; fullPath?: string }>;
}) {
  const hasExplicitSchemaFile = envGraph.sortedDataSources?.some((source) => (
    source.type === 'schema' && source.fullPath
  ));

  if (!hasExplicitSchemaFile) {
    throw new CliExitError('Cannot import plaintext secrets without .env.schema for the input file', {
      suggestion: 'Create .env.schema so Varlock knows which variables in the input env file are secrets, then mark them with @sensitive before running `varlock keychain import`.',
    });
  }
}

async function listKeychainItems(query?: string, keychain?: string) {
  const client = getDaemonClient();
  const items = await client.keychainSearch({ query, keychain });
  if (items.length === 0) {
    console.log(ansis.gray('No matching Keychain items found.'));
    return;
  }

  for (const item of items) {
    const account = item.account ? ` ${ansis.gray(item.account)}` : '';
    const kc = item.keychain ? ` ${ansis.gray(`[${item.keychain}]`)}` : '';
    console.log(`${item.service}${account}${kc}`);
  }
}

async function fixAccessForRefs(refs: Array<KeychainRef>) {
  const client = getDaemonClient();
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const ref of refs) {
    try {
      const result = await client.keychainFixAccess(ref);
      if (result.modified) updated++;
      else unchanged++;
      const label = ref.key ? `${ref.key} ` : '';
      console.log(`  ${label}${result.modified ? 'updated' : 'already allowed'}`);
    } catch (err) {
      failed++;
      const label = ref.key ? `${ref.key}: ` : '';
      console.error(ansis.red(`  ${label}${err instanceof Error ? err.message : err}`));
    }
  }

  console.log(`\nChecked ${refs.length} item${refs.length === 1 ? '' : 's'}: ${updated} updated, ${unchanged} already allowed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

async function readSecretForSet(label: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    const chunks: Array<Buffer> = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const rawValue = Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
    if (!rawValue) throw new CliExitError('No value received on stdin');
    return rawValue;
  }

  const prompted = await password({
    message: `Enter secret value for ${label}`,
    hint: 'for multi-line values, pipe via stdin',
  });
  if (isCancel(prompted)) return undefined;
  if (!prompted) throw new CliExitError('Secret value cannot be empty');
  return prompted;
}

async function setKeychainSecret(opts: {
  key?: string;
  service: string;
  account: string;
  write?: string;
  force: boolean;
}) {
  if (opts.write && !opts.key) {
    throw new CliExitError('Cannot write an env ref without an env var key', {
      suggestion: 'Use `varlock keychain set API_KEY --write .env.profile`, or omit --write.',
    });
  }

  const label = opts.key ?? opts.account;
  const value = await readSecretForSet(label);
  if (value === undefined) return;

  const client = getDaemonClient();
  if (!opts.force) {
    try {
      await client.keychainGet({
        service: opts.service,
        account: opts.account,
        field: 'account',
      });
      throw new CliExitError(`Refusing to overwrite existing Keychain item for ${label}`, {
        suggestion: 'Re-run with --force to overwrite the existing Keychain item.',
      });
    } catch (err) {
      if (err instanceof CliExitError) throw err;
      if (!isKeychainItemNotFoundError(err)) throw err;
    }
  }

  await client.keychainSet({
    service: opts.service,
    account: opts.account,
    value,
    update: opts.force,
  });

  const ref = formatKeychainRef({ service: opts.service, account: opts.account });
  if (opts.write && opts.key) {
    writeEnvRef(path.resolve(opts.write), opts.key, ref, opts.force);
  }

  console.log(`Stored ${label} in macOS Keychain.`);
  if (opts.write) {
    console.log(`Wrote ref to ${opts.write}.`);
  } else {
    console.log(`Ref: ${ref}`);
  }
}

async function importPlaintextEnv(opts: {
  from: string;
  write: string;
  service: string;
  profile: string;
  project: string;
  force: boolean;
}) {
  const fromPath = path.resolve(opts.from);
  const writePath = path.resolve(opts.write);
  if (!fs.existsSync(fromPath)) throw new CliExitError(`File not found: ${fromPath}`);

  const envGraph = await loadVarlockEnvGraph();
  assertKeychainImportSchemaPresent(envGraph);
  const sourceFile = parseEnvSpecDotEnvFile(fs.readFileSync(fromPath, 'utf-8'));
  const itemsToImport: Array<{ key: string; value: string; ref: KeychainRef }> = [];

  for (const item of sourceFile.configItems) {
    const schemaItem = envGraph.configSchema[item.key];
    const value = getSensitivePlaintextImportValue(schemaItem, item.value);
    if (value === undefined) continue;

    itemsToImport.push({
      key: item.key,
      value,
      ref: {
        service: opts.service,
        account: getGeneratedAccount(opts.project, opts.profile, item.key),
      },
    });
  }

  if (itemsToImport.length === 0) {
    console.log('No sensitive plaintext values found to import.');
    return;
  }

  const existingEnvKeys = getExistingEnvKeys(writePath);
  if (!opts.force) {
    const existingKey = itemsToImport.find((item) => existingEnvKeys.has(item.key));
    if (existingKey) {
      throw new CliExitError(`Refusing to overwrite ${existingKey.key} in ${writePath}`, {
        suggestion: 'Re-run with --force to overwrite existing env refs and Keychain items.',
      });
    }
  }

  const client = getDaemonClient();
  if (!opts.force) {
    for (const item of itemsToImport) {
      try {
        await client.keychainGet({
          service: item.ref.service,
          account: item.ref.account,
          field: 'account',
        });
        throw new CliExitError(`Refusing to overwrite existing Keychain item for ${item.key}`, {
          suggestion: 'Re-run with --force to overwrite existing env refs and Keychain items.',
        });
      } catch (err) {
        if (err instanceof CliExitError) throw err;
        if (!isKeychainItemNotFoundError(err)) throw err;
      }
    }
  }

  let imported = 0;
  for (const item of itemsToImport) {
    await client.keychainSet({
      service: item.ref.service,
      account: item.ref.account,
      value: item.value,
      update: opts.force,
    });
    writeEnvRef(writePath, item.key, formatKeychainRef(item.ref), opts.force);
    imported++;
    console.log(`  Imported ${item.key}`);
  }

  console.log(`\nImported ${imported} sensitive value${imported === 1 ? '' : 's'} into macOS Keychain.`);
  console.log(`Wrote refs to ${path.relative(process.cwd(), writePath) || writePath}.`);
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  assertMacOS();

  const positionals = (ctx.positionals ?? []).slice(ctx.commandPath?.length ?? 0);
  const action = positionals[0] ?? 'list';
  const service = String(ctx.values.service || 'varlock');
  const account = ctx.values.account ? String(ctx.values.account) : undefined;
  const keychain = ctx.values.keychain ? String(ctx.values.keychain) : undefined;

  if (action === 'list') {
    await listKeychainItems(positionals[1], keychain);
    return;
  }

  if (action === 'fix-access') {
    if (ctx.values.path) {
      const filePath = path.resolve(String(ctx.values.path));
      const refs = extractKeychainRefsFromFile(filePath);
      if (refs.length === 0) {
        console.log(ansis.gray('No explicit keychain() refs found.'));
        return;
      }
      await fixAccessForRefs(refs);
      return;
    }

    if (!account) {
      throw new CliExitError('Missing --account for keychain fix-access', {
        suggestion: 'Use --account "project:profile:KEY" or --path .env.profile',
      });
    }

    await fixAccessForRefs([{ service, account, keychain }]);
    return;
  }

  if (action === 'set') {
    if (keychain) {
      throw new CliExitError('keychain set does not support --keychain yet', {
        suggestion: 'Omit --keychain to store the item in the default login keychain.',
      });
    }

    const key = positionals[1];
    const profile = String(ctx.values.profile || 'local');
    const project = String(ctx.values.project || path.basename(process.cwd()));
    const targetAccount = account ?? (key ? getGeneratedAccount(project, profile, key) : undefined);
    if (!targetAccount) {
      throw new CliExitError('Missing env var key or --account for keychain set', {
        suggestion: 'Use `varlock keychain set API_KEY --profile local` or `varlock keychain set --account name`.',
      });
    }

    await setKeychainSecret({
      key,
      service,
      account: targetAccount,
      write: ctx.values.write ? String(ctx.values.write) : undefined,
      force: Boolean(ctx.values.force),
    });
    return;
  }

  if (action === 'import') {
    if (!ctx.values.from) throw new CliExitError('Missing --from for keychain import');
    const profile = String(ctx.values.profile || 'local');
    const project = String(ctx.values.project || path.basename(process.cwd()));
    const write = ctx.values.write ? String(ctx.values.write) : `.env.${profile}`;
    await importPlaintextEnv({
      from: String(ctx.values.from),
      write,
      service,
      profile,
      project,
      force: Boolean(ctx.values.force),
    });
    return;
  }

  throw new CliExitError(`Unknown keychain action: ${action}`, {
    suggestion: 'Use list, fix-access, import, or set.',
  });
};
