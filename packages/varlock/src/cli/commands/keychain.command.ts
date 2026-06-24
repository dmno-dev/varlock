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
import { trackCommand } from '../helpers/telemetry';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

type KeychainRef = {
  key?: string;
  service: string;
  account?: string;
  keychain?: string;
};

function assertMacOS() {
  if (process.platform !== 'darwin') {
    throw new CliExitError('varlock keychain is only supported on macOS');
  }
}

function quoteEnvString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;
}

export function formatKeychainRef(ref: KeychainRef): string {
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

  if (!service) {
    if (account) {
      throw new CliExitError(`Cannot fix access for ${key}: account-only keychain() refs are not supported`, {
        suggestion: 'Add an explicit service to the ref, for example keychain(service="varlock", account="...").',
      });
    }
    return undefined;
  }
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

type SchemaItemLike = { isSensitive?: boolean; defs?: Array<{ source?: { type?: string } }> };

/**
 * Select which config items to import, taking the value to store from the *input file's*
 * own AST node (`item.value`) — never the resolved value from the env graph, which may have
 * been overridden by another file (e.g. `.env.local`) in the scanned directory. The graph is
 * consulted only for sensitivity via `configSchema`.
 */
export function collectSensitivePlaintextImports(
  configItems: Array<{ key: string; value: unknown }>,
  configSchema: Record<string, SchemaItemLike | undefined>,
): Array<{ key: string; value: string }> {
  const items: Array<{ key: string; value: string }> = [];
  for (const item of configItems) {
    const value = getSensitivePlaintextImportValue(configSchema[item.key], item.value);
    if (value === undefined) continue;
    items.push({ key: item.key, value });
  }
  return items;
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

/** Throw a refusal error if a matching Keychain item already exists (the non-force guard). */
async function assertKeychainItemAbsent(
  client: ReturnType<typeof getDaemonClient>,
  ref: { service: string; account?: string },
  label: string,
  suggestion: string,
) {
  try {
    await client.keychainGet({ service: ref.service, account: ref.account, field: 'account' });
  } catch (err) {
    if (isKeychainItemNotFoundError(err)) return;
    throw err;
  }
  throw new CliExitError(`Refusing to overwrite existing Keychain item for ${label}`, { suggestion });
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
  if (opts.write && opts.key && !opts.force) {
    const writePath = path.resolve(opts.write);
    if (getExistingEnvKeys(writePath).has(opts.key)) {
      throw new CliExitError(`Refusing to overwrite ${opts.key} in ${writePath}`, {
        suggestion: 'Re-run with --force to overwrite the existing env ref and Keychain item.',
      });
    }
  }

  const value = await readSecretForSet(label);
  if (value === undefined) return;

  const client = getDaemonClient();
  if (!opts.force) {
    await assertKeychainItemAbsent(
      client,
      { service: opts.service, account: opts.account },
      label,
      'Re-run with --force to overwrite the existing Keychain item.',
    );
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
  /** When omitted, refs are written back into the source file in place (replacing plaintext). */
  write?: string;
  service: string;
  profile: string;
  project: string;
  force: boolean;
}) {
  const fromPath = path.resolve(opts.from);
  if (!fs.existsSync(fromPath)) throw new CliExitError(`File not found: ${fromPath}`);

  // No --write means migrate the source file in place: replacing each plaintext
  // value with its keychain() ref is the goal, not an accidental overwrite.
  const inPlace = !opts.write;
  const writePath = inPlace ? fromPath : path.resolve(opts.write!);

  // Scan the source file's directory so the sibling .env.schema is loaded too —
  // that schema is how we know which values are sensitive. Loading the file alone
  // would never surface the schema.
  const envGraph = await loadVarlockEnvGraph({ entryFilePaths: [path.dirname(fromPath)] });
  assertKeychainImportSchemaPresent(envGraph);
  // Sensitivity is only finalized during resolution (type/resolver inference) — before
  // this, every item reports isSensitive=true, which would import non-sensitive values.
  await envGraph.resolveEnvValues();

  // Values come from the input file's own parse (not the resolved graph) — see
  // collectSensitivePlaintextImports.
  const sourceFile = parseEnvSpecDotEnvFile(fs.readFileSync(fromPath, 'utf-8'));
  const itemsToImport = collectSensitivePlaintextImports(sourceFile.configItems, envGraph.configSchema)
    .map(({ key, value }) => ({
      key,
      value,
      ref: {
        service: opts.service,
        account: getGeneratedAccount(opts.project, opts.profile, key),
      } satisfies KeychainRef,
    }));

  if (itemsToImport.length === 0) {
    console.log('No sensitive plaintext values found to import.');
    return;
  }

  // When redirecting to a different file, don't clobber unrelated refs already in it.
  // (In-place mode is exempt — the keys are expected to be there as the plaintext we're replacing.)
  if (!inPlace && !opts.force) {
    const existingEnvKeys = getExistingEnvKeys(writePath);
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
      await assertKeychainItemAbsent(
        client,
        item.ref,
        item.key,
        'Re-run with --force to overwrite the existing Keychain item.',
      );
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
    // In-place always replaces the plaintext value; redirect mode appends (or replaces with --force).
    writeEnvRef(writePath, item.key, formatKeychainRef(item.ref), inPlace || opts.force);
    imported++;
    console.log(`  Imported ${item.key}`);
  }

  const relWritePath = path.relative(process.cwd(), writePath) || writePath;
  console.log(`\nImported ${imported} sensitive value${imported === 1 ? '' : 's'} into macOS Keychain.`);
  console.log(inPlace
    ? `Replaced plaintext with keychain() refs in ${relWritePath}.`
    : `Wrote refs to ${relWritePath}.`);
}

function resolveProject(project?: string): string {
  return project || path.basename(process.cwd());
}

// --- `varlock keychain list` ------------------------------------------------

const listCommand = define({
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
  run: async (ctx) => {
    assertMacOS();
    await trackCommand('keychain list', { command: 'keychain list' });
    await listKeychainItems(ctx.values.query, ctx.values.keychain);
  },
});

// --- `varlock keychain fix-access` ------------------------------------------

const fixAccessCommand = define({
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
  run: async (ctx) => {
    assertMacOS();
    await trackCommand('keychain fix-access', { command: 'keychain fix-access' });

    if (ctx.values.path) {
      const refs = extractKeychainRefsFromFile(path.resolve(ctx.values.path));
      if (refs.length === 0) {
        console.log(ansis.gray('No explicit keychain() refs found.'));
        return;
      }
      await fixAccessForRefs(refs);
      return;
    }

    if (!ctx.values.account) {
      throw new CliExitError('Missing --account for keychain fix-access', {
        suggestion: 'Use --account "project:profile:KEY" or --path .env.profile',
      });
    }

    await fixAccessForRefs([
      {
        service: ctx.values.service,
        account: ctx.values.account,
        keychain: ctx.values.keychain,
      },
    ]);
  },
});

// --- `varlock keychain set` -------------------------------------------------

const setCommand = define({
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
    write: {
      type: 'string',
      description: 'Env file to write the keychain() ref to',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing Keychain item and env ref',
    },
  },
  run: async (ctx) => {
    assertMacOS();
    await trackCommand('keychain set', { command: 'keychain set' });

    const { key, service, account } = ctx.values;
    const targetAccount = account
      ?? (key ? getGeneratedAccount(resolveProject(ctx.values.project), ctx.values.profile, key) : undefined);
    if (!targetAccount) {
      throw new CliExitError('Missing env var key or --account for keychain set', {
        suggestion: 'Use `varlock keychain set API_KEY --profile local` or `varlock keychain set --account name`.',
      });
    }

    await setKeychainSecret({
      key,
      service,
      account: targetAccount,
      write: ctx.values.write,
      force: Boolean(ctx.values.force),
    });
  },
});

// --- `varlock keychain import` ----------------------------------------------

const importCommand = define({
  name: 'import',
  description: 'Migrate sensitive plaintext values from an env file into macOS Keychain',
  args: {
    file: {
      type: 'positional',
      required: false,
      description: 'Plaintext env file to import secrets from',
    },
    write: {
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
      description: 'Overwrite existing Keychain items (and refs in a --write target)',
    },
  },
  run: async (ctx) => {
    assertMacOS();
    await trackCommand('keychain import', { command: 'keychain import' });

    if (!ctx.values.file) {
      throw new CliExitError('Missing env file to import from', {
        suggestion: 'Use `varlock keychain import .env` (edits the file in place) or add `--write .env.profile`.',
      });
    }

    await importPlaintextEnv({
      from: ctx.values.file,
      write: ctx.values.write,
      service: ctx.values.service,
      profile: ctx.values.profile,
      project: resolveProject(ctx.values.project),
      force: Boolean(ctx.values.force),
    });
  },
});

// --- `varlock keychain` (parent) --------------------------------------------

export const commandSpec = define({
  name: 'keychain',
  description: 'Manage macOS Keychain items used by keychain()',
  subCommands: {
    list: listCommand,
    'fix-access': fixAccessCommand,
    set: setCommand,
    import: importCommand,
  },
  examples: `
Examples:
  varlock keychain list
  varlock keychain fix-access --account "my-project:jb:API_KEY"
  varlock keychain fix-access --path .env.jb
  varlock keychain import .env --profile jb            # migrate .env in place
  varlock keychain import .env --profile jb --write .env.jb
  varlock keychain set API_KEY --profile jb --write .env.jb
`.trim(),
});

/** Default `varlock keychain` with no subcommand: list matching items. */
export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async () => {
  assertMacOS();
  await listKeychainItems();
};
