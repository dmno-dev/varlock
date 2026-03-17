import * as kdbxweb from 'kdbxweb';
import argon2 from 'argon2';
import fs from 'node:fs';

const { debug } = plugin;
const { ResolutionError } = plugin.ERRORS;

/** Sanitize a KeePass entry path into a valid env var name, optionally suffixing non-default attributes */
export function sanitizeEnvKey(path: string, attribute?: string): string {
  let key = path
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
  if (attribute && attribute !== 'Password') {
    key += `_${attribute.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`;
  }
  return key;
}

// Register Argon2 implementation for KDBX 4.0 support.
// kdbxweb doesn't bundle one — it must be provided externally.
kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, _version) => {
  const hashType = type === 0 ? argon2.argon2d : argon2.argon2id;
  const result = await argon2.hash(Buffer.from(password), {
    type: hashType,
    salt: Buffer.from(salt),
    memoryCost: memory,
    timeCost: iterations,
    hashLength: length,
    parallelism,
    raw: true,
  });
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
});

/**
 * Read a key file and return its contents as an ArrayBuffer for kdbxweb credentials.
 */
function readKeyFile(path?: string): ArrayBuffer | undefined {
  if (!path) return undefined;
  if (!fs.existsSync(path)) {
    throw new ResolutionError(`KeePass key file not found: ${path}`, {
      tip: 'Verify the key file path is correct.',
    });
  }
  const data = fs.readFileSync(path);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * Manages reading entries from one or more KDBX 4.0 database files.
 * Used in production mode where we read the database file(s) directly.
 */
export class KdbxReader {
  private db: kdbxweb.Kdbx | undefined;
  private dbPromise: Promise<kdbxweb.Kdbx> | undefined;

  constructor(
    private dbPath: string,
    private password: string,
    private keyFilePath?: string,
  ) {}

  private async openDatabase(): Promise<kdbxweb.Kdbx> {
    if (this.db) return this.db;
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = (async () => {
      debug('opening KDBX database:', this.dbPath);

      if (!fs.existsSync(this.dbPath)) {
        throw new ResolutionError(`KeePass database file not found: ${this.dbPath}`, {
          tip: 'Verify the database file path is correct and the file exists.',
        });
      }

      const dbData = fs.readFileSync(this.dbPath);
      const dbArrayBuffer = dbData.buffer.slice(
        dbData.byteOffset,
        dbData.byteOffset + dbData.byteLength,
      ) as ArrayBuffer;

      const credentials = new kdbxweb.KdbxCredentials(
        kdbxweb.ProtectedValue.fromString(this.password),
        readKeyFile(this.keyFilePath),
      );

      try {
        this.db = await kdbxweb.Kdbx.load(dbArrayBuffer, credentials);
        debug('KDBX database opened successfully');
        return this.db;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('InvalidKey') || msg.includes('invalid key') || msg.toLowerCase().includes('invalid credentials')) {
          throw new ResolutionError('Invalid KeePass database credentials', {
            tip: [
              'Check that the password is correct.',
              'If the database uses a key file, make sure the keyFile path is valid.',
            ],
          });
        }
        throw new ResolutionError(`Failed to open KeePass database: ${msg}`, {
          tip: 'Verify the database file is a valid KDBX 4.0 file and the credentials are correct.',
        });
      }
    })();

    return this.dbPromise;
  }

  /**
   * Find an entry by its path (e.g., "Group/SubGroup/EntryTitle").
   */
  private findEntry(db: kdbxweb.Kdbx, entryPath: string): kdbxweb.KdbxEntry | undefined {
    const parts = entryPath.split('/');
    const entryTitle = parts.pop()!;
    let group = db.getDefaultGroup();

    // Navigate through groups
    for (const groupName of parts) {
      const found = group.groups.find(
        (g) => g.name === groupName,
      );
      if (!found) return undefined;
      group = found;
    }

    // Find the entry in the final group
    return group.entries.find(
      (e) => e.fields.get('Title')?.toString() === entryTitle,
    );
  }

  /**
   * Read a specific field from an entry by path.
   * Defaults to "Password" if no attribute is specified.
   */
  async readEntry(entryPath: string, attribute: string = 'Password'): Promise<string> {
    const db = await this.openDatabase();
    const entry = this.findEntry(db, entryPath);

    if (!entry) {
      throw new ResolutionError(`KeePass entry "${entryPath}" not found`, {
        code: 'ENTRY_NOT_FOUND',
        tip: [
          'Double-check the entry path in your KeePass database.',
          'Entry paths use forward slashes to separate groups, e.g., "MyGroup/MyEntry".',
          'The path is case-sensitive.',
        ],
      });
    }

    const field = entry.fields.get(attribute);
    if (field === undefined || field === null) {
      throw new ResolutionError(`KeePass entry "${entryPath}" does not have attribute "${attribute}"`, {
        code: 'ATTRIBUTE_NOT_FOUND',
        tip: [
          'Common attributes: Password, UserName, URL, Notes, Title.',
          'Custom string fields use the exact name as defined in the entry.',
        ],
      });
    }

    // kdbxweb returns ProtectedValue for password fields, plain strings for others
    if (field instanceof kdbxweb.ProtectedValue) {
      return field.getText();
    }
    return String(field);
  }

  /**
   * List all entry paths under a given group prefix.
   */
  async listEntries(groupPath?: string): Promise<Array<string>> {
    const db = await this.openDatabase();
    const entries: Array<string> = [];

    function collectEntries(group: kdbxweb.KdbxGroup, pathPrefix: string) {
      for (const entry of group.entries) {
        const title = entry.fields.get('Title')?.toString();
        if (title) {
          entries.push(pathPrefix ? `${pathPrefix}/${title}` : title);
        }
      }
      for (const subGroup of group.groups) {
        if (subGroup.name) {
          collectEntries(subGroup, pathPrefix ? `${pathPrefix}/${subGroup.name}` : subGroup.name);
        }
      }
    }

    let startGroup = db.getDefaultGroup();
    let startPath = '';

    if (groupPath) {
      const parts = groupPath.split('/');
      for (const part of parts) {
        const found = startGroup.groups.find((g) => g.name === part);
        if (!found) return [];
        startGroup = found;
      }
      startPath = groupPath;
    }

    collectEntries(startGroup, startPath);
    return entries;
  }

  /**
   * Read all entries under a group, returning a flat {entryPath: password} map as JSON.
   */
  async readAllEntries(groupPath?: string, attribute: string = 'Password'): Promise<string> {
    const entryPaths = await this.listEntries(groupPath);
    const result: Record<string, string> = {};

    await Promise.all(entryPaths.map(async (path) => {
      try {
        result[sanitizeEnvKey(path, attribute)] = await this.readEntry(path, attribute);
      } catch {
        // Skip entries that don't have the requested attribute
      }
    }));

    return JSON.stringify(result);
  }
}
