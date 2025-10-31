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
export function execSyncVarlock(
  command: string,
  opts?: (Parameters<typeof execSyncType>[1] & {
    exitOnError?: boolean,
    showLogsOnError?: boolean,
  }),
) {
  try {
    // in most cases, user will be running via their package manager
    // and a package.json script (ie `pnpm run start`)
    // which will inject node_modules/.bin into PATH
    try {
      const result = execSync(`varlock ${command}`, {
        ...opts?.env && { env: opts.env },
        stdio: 'pipe',
      });
      return result.toString();
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
          const result = execSync(`${possibleVarlockPath} ${command}`, {
            ...opts,
            stdio: 'pipe',
          });
          // const commandArgs = command.split(' ').filter(Boolean);
          // const result = execFileSync(possibleVarlockPath, commandArgs, opts);
          return result.toString();
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
  } catch (err) {
    const errAny = err as any;
    if (opts?.showLogsOnError) {
      /* eslint-disable no-console */
      if (errAny.stdout) console.log(errAny.stdout.toString());
      if (errAny.stderr) console.error(errAny.stderr.toString());

      if (!errAny.stdout && !errAny.stderr) {
        console.error(errAny);
      }
    }
    if (opts?.exitOnError) {
      process.exit((err as any).status ?? 1);
    }
    throw err;
  }
}
