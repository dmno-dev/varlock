import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

// weird tsup issue using `typeof execSync` from node:child_process
// see https://github.com/egoist/tsup/issues/1367
import type { execSync as execSyncType } from 'child_process';

/**
 * small helper to call execSync and call the varlock cli
 *
 * when end user runs via a package manager, it will inject node_modules/.bin into PATH
 * but otherwise we may need to try to find that path ourselves
 */
export function execSyncVarlock(command: string, opts?: Parameters<typeof execSyncType>[1]) {
  // in most cases, user will be running via their package manager
  // and a package.json script (ie `pnpm run start`)
  // which will inject node_modules/.bin into PATH
  try {
    return execSync(`varlock ${command}`, {
      ...opts,
      stdio: 'ignore', // we need to supress the output
    });
  } catch (err) {
    // code 127 means not found
    if ((err as any).status !== 127) throw err;
  }

  // if varlock was not found, it either means it is not installed
  // or we must find the path to node_modules/.bin ourselves
  // so we'll walk up the directory tree looking for it
  let currentDir = process.cwd();
  while (currentDir) {
    const possibleBinPath = path.join(currentDir, 'node_modules', '.bin');
    if (fs.existsSync(possibleBinPath)) {
      const possibleVarlockPath = path.join(possibleBinPath, 'varlock');
      if (fs.existsSync(possibleVarlockPath)) {
        return execSync(`${possibleVarlockPath} ${command}`, opts);
      } else {
        throw new Error('Unable to find varlock executable');
      }
    }
    // when we reach the root, it will stop
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = path.dirname(currentDir);
  }

  throw new Error('Unable to find varlock executable');
}
