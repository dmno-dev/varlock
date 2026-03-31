import { plugin } from 'varlock/plugin-lib';
import { ExecError, spawnAsync } from '@env-spec/utils/exec-helpers';

const { debug } = plugin;
const { ResolutionError } = plugin.ERRORS;

const FIX_INSTALL_TIP = [
  'The `keepassxc-cli` command was not found on your system.',
  'Install KeePassXC which includes the CLI:',
  '  macOS:   brew install --cask keepassxc',
  '  Ubuntu:  sudo apt install keepassxc',
  '  Fedora:  sudo dnf install keepassxc',
  '  Arch:    pacman -S keepassxc',
  'See https://keepassxc.org/download/ for more info.',
].join('\n');

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

/**
 * Per-instance CLI reader that stores its own auth credentials.
 */
export class KpCliReader {
  constructor(
    private dbPath: string,
    private password: string,
    private keyFile?: string,
  ) {}

  async readEntry(entryPath: string, attribute: string = 'Password'): Promise<string> {
    const args = [
      'show',
      ...(this.keyFile ? ['--key-file', this.keyFile] : []),
      '--attributes',
      attribute,
      '--quiet',
      this.dbPath,
      entryPath,
    ];
    const result = await execKeePassCliCommand(args, this.password);
    return result.trimEnd();
  }

  async listEntries(groupPath?: string): Promise<Array<string>> {
    const args = [
      'ls',
      ...(this.keyFile ? ['--key-file', this.keyFile] : []),
      '--recursive',
      '--flatten',
      this.dbPath,
      ...(groupPath ? [groupPath] : []),
    ];
    const result = await execKeePassCliCommand(args, this.password);
    return result
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/'));
  }
}
