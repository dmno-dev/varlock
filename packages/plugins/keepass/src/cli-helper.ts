import { ExecError, spawnAsync } from '@env-spec/utils/exec-helpers';
import { createDeferredPromise, DeferredPromise } from '@env-spec/utils/defer';

const { debug } = plugin;
const { ResolutionError } = plugin.ERRORS;

const ENABLE_BATCHING = true;
const BATCH_READ_TIMEOUT = 50;

const FIX_INSTALL_TIP = [
  'The `keepassxc-cli` command was not found on your system.',
  'Install KeePassXC which includes the CLI:',
  '  macOS:   brew install --cask keepassxc',
  '  Ubuntu:  sudo apt install keepassxc',
  '  Fedora:  sudo dnf install keepassxc',
  '  Arch:    pacman -S keepassxc',
  'See https://keepassxc.org/download/ for more info.',
].join('\n');

let kdbxPasswordForCli: string | undefined;
let kdbxPathForCli: string | undefined;
let kdbxKeyFileForCli: string | undefined;

export function configureCliAuth(dbPath: string, password: string, keyFile?: string) {
  kdbxPathForCli = dbPath;
  kdbxPasswordForCli = password;
  kdbxKeyFileForCli = keyFile;
}

function processCliError(err: Error | any): Error {
  if (err instanceof ExecError) {
    const errMessage = err.data;
    debug('keepassxc-cli error --', errMessage);

    if (errMessage.includes('Invalid credentials')) {
      return new ResolutionError('KeePassXC database credentials are invalid', {
        tip: [
          'Check that the password provided to @initKeePass is correct.',
          'If using a key file, make sure the keyFile path is valid.',
        ],
      });
    } else if (errMessage.includes('Failed to open database') || errMessage.includes('Error while reading the database')) {
      return new ResolutionError(`Failed to open KeePass database: ${errMessage.trim()}`, {
        tip: [
          'Verify the database path is correct and the file exists.',
          'Check that the file is a valid KDBX database.',
        ],
      });
    } else if (errMessage.includes('Could not find entry')) {
      const matches = errMessage.match(/Could not find entry with path (.+)\./);
      const entryPath = matches?.[1]?.trim() || 'unknown';
      return new ResolutionError(`KeePass entry "${entryPath}" not found`, {
        code: 'ENTRY_NOT_FOUND',
        tip: [
          'Double-check the entry path in your KeePass database.',
          'Use `keepassxc-cli ls <db>` to list available entries.',
          'Entry paths are case-sensitive.',
        ],
      });
    } else if (errMessage.includes('No attribute') || errMessage.includes('no attribute')) {
      return new ResolutionError(`KeePass entry attribute not found: ${errMessage.trim()}`, {
        code: 'ATTRIBUTE_NOT_FOUND',
        tip: [
          'Check the attribute name. Common attributes: Password, UserName, URL, Notes, Title.',
          'Custom string fields use the exact name as defined in the entry.',
          'Use `keepassxc-cli show <db> <entry>` to see available attributes.',
        ],
      });
    }

    if (!errMessage) {
      return new ResolutionError('KeePassXC CLI returned an error with no message');
    }
    return new ResolutionError(`KeePassXC CLI error - ${errMessage.trim()}`);
  } else if ((err as any).code === 'ENOENT') {
    return new ResolutionError('KeePassXC CLI `keepassxc-cli` not found', {
      tip: FIX_INSTALL_TIP,
    });
  } else {
    return new ResolutionError(`Problem invoking KeePassXC CLI: ${(err as any).message}`);
  }
}

async function execKeePassCliCommand(args: Array<string>, stdinInput?: string): Promise<string> {
  const startAt = new Date();
  try {
    debug('keepassxc-cli args', args);
    const result = await spawnAsync('keepassxc-cli', args, {
      input: stdinInput,
    });
    debug(`> took ${+new Date() - +startAt}ms`);
    return result;
  } catch (err) {
    throw processCliError(err);
  }
}


let readBatch: Record<string, {
  attribute: string;
  deferredPromises: Array<DeferredPromise<string>>;
}> | undefined;

async function executeReadBatch(batchToExecute: NonNullable<typeof readBatch>) {
  if (!kdbxPathForCli || !kdbxPasswordForCli) {
    const err = new ResolutionError('KeePassXC CLI not configured', {
      tip: 'Ensure @initKeePass has been called with a valid database path and password.',
    });
    for (const key in batchToExecute) {
      batchToExecute[key].deferredPromises.forEach((p) => p.reject(err));
    }
    return;
  }

  // keepassxc-cli doesn't have a built-in batch mode, so we run individual `show` commands
  // but we parallelise them within a batch window to minimize perceived latency
  const entries = Object.entries(batchToExecute);
  debug('execute keepass read batch', entries.length, 'items');

  await Promise.all(entries.map(async ([key, { attribute, deferredPromises }]) => {
    const [entryPath] = key.split('\0');
    try {
      const args = [
        'show',
        ...(kdbxKeyFileForCli ? ['--key-file', kdbxKeyFileForCli] : []),
        '--attributes',
        attribute,
        '--quiet',
        kdbxPathForCli!,
        entryPath,
      ];
      const result = await execKeePassCliCommand(args, kdbxPasswordForCli);
      const value = result.trimEnd();
      deferredPromises.forEach((p) => p.resolve(value));
    } catch (err) {
      deferredPromises.forEach((p) => p.reject(err));
    }
  }));
}

/**
 * Read a single attribute from a KeePass entry via keepassxc-cli.
 * Internally batches requests using a short timeout window.
 */
export async function kpCliRead(
  entryPath: string,
  attribute: string = 'Password',
): Promise<string> {
  // batch key includes both entry path and attribute for deduplication
  const batchKey = `${entryPath}\0${attribute}`;

  if (ENABLE_BATCHING) {
    let shouldExecuteBatch = false;
    if (!readBatch) {
      readBatch = {};
      shouldExecuteBatch = true;
    }

    readBatch[batchKey] ||= {
      attribute,
      deferredPromises: [],
    };

    const deferred = createDeferredPromise<string>();
    readBatch[batchKey].deferredPromises.push(deferred);

    if (shouldExecuteBatch) {
      setTimeout(async () => {
        if (!readBatch) throw Error('expected to find keepass read batch!');
        const batchToExecute = readBatch;
        readBatch = undefined;
        await executeReadBatch(batchToExecute);
      }, BATCH_READ_TIMEOUT);
    }
    return deferred.promise;
  } else {
    if (!kdbxPathForCli || !kdbxPasswordForCli) {
      throw new ResolutionError('KeePassXC CLI not configured');
    }
    const args = [
      'show',
      ...(kdbxKeyFileForCli ? ['--key-file', kdbxKeyFileForCli] : []),
      '--attributes',
      attribute,
      '--quiet',
      kdbxPathForCli,
      entryPath,
    ];
    const result = await execKeePassCliCommand(args, kdbxPasswordForCli);
    return result.trimEnd();
  }
}

/**
 * List all entries in a group (folder) of the database.
 */
export async function kpCliList(groupPath?: string): Promise<Array<string>> {
  if (!kdbxPathForCli || !kdbxPasswordForCli) {
    throw new ResolutionError('KeePassXC CLI not configured');
  }

  const args = [
    'ls',
    ...(kdbxKeyFileForCli ? ['--key-file', kdbxKeyFileForCli] : []),
    '--recursive',
    '--flatten',
    kdbxPathForCli,
    ...(groupPath ? [groupPath] : []),
  ];
  const result = await execKeePassCliCommand(args, kdbxPasswordForCli);
  return result
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/')); // filter out groups (directories)
}
